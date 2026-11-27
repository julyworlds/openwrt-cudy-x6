'use strict';
'require baseclass';
'require fs';
'require ui';
'require rpc';
'require uci';

/* Shared by the EasyMesh status and clients views. */

var CLI = '/usr/libexec/prplmesh/bin/beerocks_cli';

var callDHCPLeases = rpc.declare({
	object: 'luci-rpc',
	method: 'getDHCPLeases',
	expect: { '': {} }
});

var callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: [ 'name' ],
	expect: { '': {} }
});

/*
 * Parse the text printed by "beerocks_cli -c bml_conn_map":
 *
 * GW_BRIDGE: name: GW_MASTER, AL-MAC: .., ipv4: .., Status: Active
 *     RADIO: wlan1 mac: .., ch: 36, bw: 80MHzL, freq: 5180MHz
 *         fVAP[0]: wlan1.0 bssid: .., ssid: ..
 *             CLIENT: mac: .., ipv4: .., name: .., ch: 36, bw: 80MHzL, rx_rssi: -60
 * (name, ch/bw, rx_rssi and "11k: 0|1|?, 11v: 0|1" only when known)
 *     IRE_BRIDGE: name: .., AL-MAC: .., ipv4: .., Status: Active
 */
function parseConnMap(text) {
	var nodes = [], node = null, radio = null, vap = null, m;

	/* Nesting is only given by indentation: a gateway's radios may be
	 * printed after the extenders hanging off it. */
	function ownerOf(indent) {
		for (var i = nodes.length - 1; i >= 0; i--)
			if (nodes[i].indent < indent)
				return nodes[i];
		return null;
	}

	(text || '').split(/\n/).forEach(function(line) {
		var indent = line.search(/\S/);

		if ((m = line.match(/(GW_BRIDGE|IRE_BRIDGE): name: ([^,]*), AL-MAC: ([0-9a-fA-F:]+), ipv4: ([^,]*), Status: (\S+)/))) {
			node = {
				indent: indent,
				gateway: m[1] == 'GW_BRIDGE',
				name: m[2],
				almac: m[3],
				ipv4: m[4],
				status: m[5],
				radios: []
			};
			nodes.push(node);
			radio = vap = null;
		}
		else if ((m = line.match(/RADIO:?\s+(?:(\S+)\s+)?mac: ([0-9a-fA-F:]+), ch: (\d+), bw: ([^,]+), freq: (\d+)MHz/)) &&
		         (node = ownerOf(indent)) != null) {
			radio = {
				ifname: m[1] || '',
				mac: m[2],
				channel: +m[3],
				bw: m[4],
				freq: +m[5],
				vaps: []
			};
			node.radios.push(radio);
			vap = null;
		}
		else if (/^\s*(ETHERNET|Eth_BACKHAUL|WiFi_BACKHAUL):/.test(line)) {
			/* clients listed after this belong to a wired port, not a VAP */
			vap = null;
		}
		else if (radio && (m = line.match(/([fb])VAP\[(\d+)\]:\s+(?:(\S+)\s+)?bssid: ([0-9a-fA-F:]+), ssid: (.*)$/))) {
			vap = {
				backhaul: m[1] == 'b',
				ifname: m[3] || '',
				bssid: m[4],
				ssid: m[5].trim(),
				clients: []
			};
			radio.vaps.push(vap);
		}
		else if (vap && (m = line.match(/CLIENT: mac: ([0-9a-fA-F:]+), ipv4: ([^,]*)(?:, name: ([^,]*))?(?:, ch: (\d+), bw: ([^,]+))?(?:, rx_rssi: (-?\d+))?(?:, 11k: ([01?]), 11v: ([01]))?/))) {
			vap.clients.push({
				mac: m[1],
				ipv4: m[2],
				name: m[3] || '',
				rssi: m[6] != null ? +m[6] : null,
				/* true / false / null (unknown) */
				k11: m[7] == '1' ? true : (m[7] == '0' ? false : null),
				v11: m[8] == '1' ? true : (m[8] == '0' ? false : null)
			});
		}
	});

	return nodes;
}

function bandOf(freq) {
	if (freq >= 5925) return '6 GHz';
	if (freq >= 4900) return '5 GHz';
	return '2.4 GHz';
}

function nodeTitle(node) {
	return '%s (%s)'.format(node.gateway ? _('Controller') : node.name, node.almac);
}

/*
 * SSIDs of the BSS profiles in /etc/config/prplmesh. Agents report every
 * BSS of their radios, including networks EasyMesh doesn't manage (a guest
 * or VPN SSID on the router), so those are hidden from the topology. An
 * extender doesn't say which of its BSSes are backhaul, so the profile is
 * also used to label backhaul-only SSIDs.
 * Returns null when no explicit profiles are used (nothing is filtered).
 */
function meshProfiles() {
	var profiles = {}, any = false;

	if (uci.get('prplmesh', 'config', 'use_explicit_bss_profiles') == '0')
		return null;

	uci.sections('prplmesh', 'bss_profile', function(s) {
		if (!s.ssid)
			return;
		var p = profiles[s.ssid] || (profiles[s.ssid] = { fronthaul: false, backhaul: false });
		if (s.fronthaul != '0') p.fronthaul = true;
		if (s.backhaul == '1') p.backhaul = true;
		any = true;
	});

	return any ? profiles : null;
}

/* Drop the VAPs outside the mesh and set the backhaul flag from the
 * profile. */
function applyProfiles(nodes, profiles) {
	if (!profiles)
		return nodes;

	nodes.forEach(function(node) {
		node.radios.forEach(function(radio) {
			radio.vaps = radio.vaps.filter(function(vap) {
				var p = profiles[vap.ssid];

				if (!p)
					return false;
				if (p.backhaul && !p.fronthaul)
					vap.backhaul = true;
				return true;
			});
		});
	});

	return nodes;
}

function fronthaulTargets(nodes) {
	var targets = [];

	nodes.forEach(function(node) {
		node.radios.forEach(function(radio) {
			radio.vaps.forEach(function(vap) {
				if (!vap.backhaul)
					targets.push({
						bssid: vap.bssid,
						label: '%s – %s (%s)'.format(node.gateway ? _('Router') : node.name,
							vap.ssid, bandOf(radio.freq))
					});
			});
		});
	});

	return targets;
}

function steerClient(mac, bssid) {
	return fs.exec(CLI, [ '-c', 'steer_client %s %s'.format(mac, bssid) ]).then(function(res) {
		var out = ((res.stdout || '') + (res.stderr || '')).trim();
		var ok = res.code === 0 && !/fail|error/i.test(out);

		ui.addNotification(null, E('p', ok
			? _('Steering request for %s sent to %s.').format(mac, bssid)
			: _('Steering %s failed: %s').format(mac, out || res.code)), ok ? 'info' : 'warning');
	}).catch(function(err) {
		ui.addNotification(null, E('p', _('Steering failed: %s').format(err.message)), 'danger');
	});
}

function loadMap() {
	uci.unload('prplmesh');
	return Promise.all([
		L.resolveDefault(fs.exec(CLI, [ '-c', 'bml_conn_map' ]), null),
		L.resolveDefault(uci.load('prplmesh'), null)
	]).then(function(r) {
		var text = r[0] ? (r[0].stdout || '') : '';
		return {
			res: r[0],
			text: text,
			nodes: applyProfiles(parseConnMap(text), meshProfiles())
		};
	});
}

return baseclass.extend({
	CLI: CLI,
	callDHCPLeases: callDHCPLeases,
	callServiceList: callServiceList,
	parseConnMap: parseConnMap,
	bandOf: bandOf,
	nodeTitle: nodeTitle,
	meshProfiles: meshProfiles,
	applyProfiles: applyProfiles,
	fronthaulTargets: fronthaulTargets,
	steerClient: steerClient,
	loadMap: loadMap
});
