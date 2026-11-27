'use strict';
'require view';
'require fs';
'require ui';
'require poll';
'require rpc';
'require dom';

var CLI = '/usr/libexec/prplmesh/bin/beerocks_cli';

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
 *             CLIENT: mac: .., ipv4: .., ch: 36, bw: 80MHzL, rx_rssi: -60
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
		else if (vap && (m = line.match(/CLIENT: mac: ([0-9a-fA-F:]+), ipv4: ([^,]*), ch: (\d+), bw: ([^,]+), rx_rssi: (-?\d+)/))) {
			vap.clients.push({
				mac: m[1],
				ipv4: m[2],
				rssi: +m[5]
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

function fronthaulTargets(nodes) {
	var targets = [];

	nodes.forEach(function(node) {
		node.radios.forEach(function(radio) {
			radio.vaps.forEach(function(vap) {
				if (!vap.backhaul)
					targets.push({
						bssid: vap.bssid,
						label: '%s – %s %s (%s)'.format(node.gateway ? _('Router') : node.name,
							vap.ssid, bandOf(radio.freq), vap.bssid)
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

return view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(callServiceList('prplmesh'), {}),
			L.resolveDefault(fs.exec(CLI, [ '-c', 'bml_conn_map' ]), null)
		]);
	},

	renderService: function(services) {
		var instances = L.isObject(services.prplmesh) ? (services.prplmesh.instances || {}) : {};
		var names = { transport: '1905 transport', controller: _('Controller'), agent: _('Agent') };

		return E('div', { 'class': 'cbi-section' }, [
			E('h3', _('Services')),
			E('table', { 'class': 'table' }, Object.keys(names).filter(function(k) {
				return instances[k] || k != 'controller' || Object.keys(instances).length == 0;
			}).map(function(k) {
				var running = instances[k] && instances[k].running;

				return E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left', 'width': '33%' }, names[k]),
					E('td', { 'class': 'td left' }, running
						? E('span', { 'style': 'color:green' }, _('Running (PID %d)').format(instances[k].pid))
						: E('span', { 'style': 'color:#c00' }, _('Not running')))
				]);
			}))
		]);
	},

	renderNodes: function(nodes) {
		var targets = fronthaulTargets(nodes);

		if (!nodes.length)
			return E('div', { 'class': 'cbi-section' }, [
				E('h3', _('Topology')),
				E('p', { 'class': 'cbi-section-descr' },
					_('No topology available. Is the prplMesh controller running?'))
			]);

		return E('div', {}, nodes.map(function(node) {
			var rows = [], clients = [];

			node.radios.forEach(function(radio) {
				radio.vaps.forEach(function(vap) {
					rows.push(E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td left' }, '%s, %s %d'.format(bandOf(radio.freq), _('ch.'), radio.channel)),
						E('td', { 'class': 'td left' }, radio.bw),
						E('td', { 'class': 'td left' }, vap.ssid),
						E('td', { 'class': 'td left' }, vap.backhaul ? _('Backhaul') : _('Fronthaul')),
						E('td', { 'class': 'td left' }, vap.bssid),
						E('td', { 'class': 'td left' }, vap.ifname || '-')
					]));

					vap.clients.forEach(function(client) {
						var select = E('select', { 'class': 'cbi-input-select' }, targets.filter(function(t) {
							return t.bssid != vap.bssid;
						}).map(function(t) {
							return E('option', { 'value': t.bssid }, t.label);
						}));

						clients.push(E('tr', { 'class': 'tr' }, [
							E('td', { 'class': 'td left' }, client.mac),
							E('td', { 'class': 'td left' }, '%s (%s)'.format(vap.ssid, bandOf(radio.freq))),
							E('td', { 'class': 'td left' }, client.rssi > -127 ? '%d dBm'.format(client.rssi) : '-'),
							E('td', { 'class': 'td left' }, [
								select, ' ',
								E('button', {
									'class': 'cbi-button cbi-button-action',
									'click': ui.createHandlerFn(this, function() {
										return steerClient(client.mac, select.value);
									})
								}, _('Move'))
							])
						]));
					});
				});
			});

			return E('div', { 'class': 'cbi-section' }, [
				E('h3', [
					nodeTitle(node), ' ',
					E('small', { 'style': node.status == 'Active' ? 'color:green' : 'color:#c00' }, node.status)
				]),
				E('table', { 'class': 'table' }, [
					E('tr', { 'class': 'tr table-titles' }, [
						E('th', { 'class': 'th' }, _('Radio')),
						E('th', { 'class': 'th' }, _('Width')),
						E('th', { 'class': 'th' }, _('SSID')),
						E('th', { 'class': 'th' }, _('Type')),
						E('th', { 'class': 'th' }, _('BSSID')),
						E('th', { 'class': 'th' }, _('Interface'))
					])
				].concat(rows)),
				clients.length ? E('table', { 'class': 'table' }, [
					E('tr', { 'class': 'tr table-titles' }, [
						E('th', { 'class': 'th' }, _('Client')),
						E('th', { 'class': 'th' }, _('Connected to')),
						E('th', { 'class': 'th' }, _('Signal')),
						E('th', { 'class': 'th' }, _('Steer to'))
					])
				].concat(clients)) : E('p', { 'class': 'cbi-section-descr' }, _('No clients reported by this node.'))
			]);
		}));
	},

	renderAll: function(data) {
		var res = data[1];
		var text = res ? (res.stdout || '') : '';

		return E('div', {}, [
			this.renderService(data[0] || {}),
			this.renderNodes(parseConnMap(text)),
			E('details', { 'class': 'cbi-section' }, [
				E('summary', _('Raw output (bml_conn_map)')),
				E('pre', { 'style': 'white-space:pre-wrap' }, text || (res ? res.stderr : _('Command failed')))
			])
		]);
	},

	render: function(data) {
		var container = E('div', { 'id': 'prplmesh-status' }, this.renderAll(data));

		poll.add(L.bind(function() {
			return this.load().then(L.bind(function(d) {
				var details = container.querySelector('details');

				// Do not redraw under a user picking a steering target.
				if (container.contains(document.activeElement) &&
				    document.activeElement.tagName == 'SELECT')
					return;

				var open = details && details.open;

				dom.content(container, this.renderAll(d));
				if (open)
					container.querySelector('details').open = true;
			}, this));
		}, this), 15);

		return E('div', {}, [
			E('h2', _('EasyMesh status')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Mesh topology as seen by the prplMesh controller. "Move" asks the client to roam to another access point (802.11v BSS transition); the client may refuse.')),
			container
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
