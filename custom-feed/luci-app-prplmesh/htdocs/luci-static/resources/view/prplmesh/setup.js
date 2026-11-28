'use strict';
'require view';
'require dom';
'require fs';
'require poll';
'require rpc';
'require uci';
'require ui';
'require tools.prplmesh as pm';

/*
 * Easy setup of EasyMesh on the main router: checks what EasyMesh needs
 * (and what made it fail before), prepares the wireless and prplMesh
 * configuration for the networks picked, and starts WPS to add an extender.
 * Every change is staged in UCI: it is reviewed and applied with LuCI's
 * "Save & Apply".
 */

/* netifd's wireless status with each interface's section and netdev. Not
 * network.wireless status itself: through rpcd it gets the session as an
 * extra argument, which netifd rejects (invalid argument). */
var callWirelessStatus = rpc.declare({
	object: 'luci-rpc',
	method: 'getWirelessDevices',
	expect: { '': {} }
});

function hostapdCall(ifname, method) {
	return rpc.declare({
		object: 'hostapd.' + ifname,
		method: method,
		expect: { '': {} }
	})();
}

/* Wireless state: wifi-iface sections with their netdev and band. */
function wirelessIfaces(status) {
	var list = [];

	uci.sections('wireless', 'wifi-iface', function(s) {
		var dev = s.device, band = uci.get('wireless', dev, 'band') || '', ifname = null;
		var st = status[dev];

		if (st && Array.isArray(st.interfaces))
			st.interfaces.forEach(function(i) {
				if (i.section == s['.name'])
					ifname = i.ifname;
			});

		list.push({
			section: s['.name'],
			device: dev,
			band: band,
			ifname: ifname,
			mode: s.mode,
			ssid: s.ssid || '',
			encryption: s.encryption || 'none',
			disabled: s.disabled == '1' || uci.get('wireless', dev, 'disabled') == '1',
			multi_ap: s.multi_ap || '0',
			s: s
		});
	});

	return list;
}

function hasBssOption(s, opt) {
	return L.toArray(s.hostapd_bss_options).some(function(o) { return o.split('=')[0] == opt.split('=')[0]; });
}

/* Set an option only when it changes, so running the setup again on a
 * configured router stages nothing. */
function setIf(conf, sid, opt, val) {
	var cur = uci.get(conf, sid, opt);
	if (L.toArray(cur).join('\n') !== L.toArray(val).join('\n'))
		uci.set(conf, sid, opt, val);
}

function addBssOption(section, opt) {
	var cur = L.toArray(uci.get('wireless', section, 'hostapd_bss_options'));
	if (cur.indexOf(opt) >= 0)
		return;
	var list = cur.filter(function(o) { return o.split('=')[0] != opt.split('=')[0]; });
	list.push(opt);
	uci.set('wireless', section, 'hostapd_bss_options', list);
}

function isBackhaul(w) { return w.mode == 'ap' && w.multi_ap == '1'; }
function isFronthaulAp(w) { return w.mode == 'ap' && w.multi_ap != '1'; }

/* Fronthaul networks of the mesh: the BSS profiles, else none. */
function meshFronthauls(ifaces) {
	var ssids = {};
	uci.sections('prplmesh', 'bss_profile', function(p) {
		if (p.fronthaul != '0' && p.ssid)
			ssids[p.ssid] = true;
	});
	return ifaces.filter(function(w) { return isFronthaulAp(w) && ssids[w.ssid]; });
}

function randomKey() {
	var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789', out = '';
	var buf = new Uint8Array(24);
	window.crypto.getRandomValues(buf);
	for (var i = 0; i < buf.length; i++)
		out += chars[buf[i] % chars.length];
	return out;
}

function bandName(band) {
	return { '2g': '2.4 GHz', '5g': '5 GHz', '6g': '6 GHz' }[band] || band || '?';
}

return view.extend({
	load: function() {
		uci.unload('wireless');
		uci.unload('prplmesh');
		uci.unload('dhcp');
		uci.unload('network');
		return Promise.all([
			uci.load('wireless'),
			uci.load('prplmesh'),
			L.resolveDefault(uci.load('dhcp'), null),
			L.resolveDefault(uci.load('network'), null),
			L.resolveDefault(callWirelessStatus(), {}),
			L.resolveDefault(fs.list('/var/run/hostapd'), []),
			L.resolveDefault(pm.callServiceList('prplmesh'), {}),
			L.resolveDefault(fs.exec(pm.CLI, [ '-c', 'bml_conn_map' ]), null)
		]).then(function(r) {
			r.splice(2, 2); /* dhcp, network: only loaded into uci */
			var ifaces = wirelessIfaces(r[2] || {});
			var sockets = (r[3] || []).map(function(e) { return e.name; });
			/* Networks configured to onboard extenders (from the configuration;
			 * their interface comes from netifd's status) */
			var onboarding = ifaces.filter(function(w) {
				return isFronthaulAp(w) && w.s.wps_pushbutton == '1' &&
				       (w.multi_ap == '2' || w.multi_ap == '3');
			});

			/* WPS support of hostapd: wps_status answers */
			return Promise.all(onboarding.map(function(w) {
				return w.ifname ? L.resolveDefault(hostapdCall(w.ifname, 'wps_status'), null) : Promise.resolve(null);
			})).then(function(wps) {
				return {
					role: uci.get('prplmesh', 'config', 'management_mode') == 'Multi-AP-Agent' ? 'agent' : 'controller',
					ifaces: ifaces,
					sockets: sockets,
					services: r[4] || {},
					nodes: pm.parseConnMap(r[5] ? (r[5].stdout || '') : ''),
					onboarding: onboarding,
					wps: wps,
					/* netifd status readable (needs this app's permissions,
					 * granted at login) */
					statusOk: Object.keys(r[2] || {}).length > 0
				};
			});
		});
	},

	/* ---- Checks ------------------------------------------------------ */

	checks: function(st) {
		return st.role == 'agent' ? this.agentChecks(st) : this.controllerChecks(st);
	},

	controllerChecks: function(st) {
		var list = [];
		var add = function(level, title, detail, fix) {
			list.push({ level: level, title: title, detail: detail, fix: fix });
		};
		var instances = L.isObject(st.services.prplmesh) ? (st.services.prplmesh.instances || {}) : {};
		var mode = uci.get('prplmesh', 'config', 'management_mode') || 'Multi-AP-Controller-and-Agent';
		var fronthauls = meshFronthauls(st.ifaces);
		var backhauls = st.ifaces.filter(isBackhaul);

		/* Service */
		if (uci.get('prplmesh', 'config', 'enabled') != '1')
			add('error', _('EasyMesh is disabled'), _('Enable it in Settings or run the setup below.'),
				function() { uci.set('prplmesh', 'config', 'enabled', '1'); });
		else if (!instances.agent || !instances.agent.running)
			add('error', _('The prplMesh agent is not running'), _('Check the system log (prplmesh).'));
		else if (/Controller/.test(mode) && (!instances.controller || !instances.controller.running))
			add('error', _('The prplMesh controller is not running'), _('Check the system log (prplmesh).'));
		else
			add('ok', _('prplMesh is running'), mode);

		if (!st.statusOk)
			add('warn', _('The WiFi status can\'t be read'),
				_('Interfaces and WPS can\'t be checked. After updating this app, log out of LuCI and in again (its permissions are granted at login).'));

		/* Networks of the mesh */
		if (!fronthauls.length)
			add('error', _('No WiFi network is part of the mesh'),
				_('No network matches the EasyMesh network profiles. Pick them in the setup below.'));

		fronthauls.forEach(function(w) {
			var name = '%s (%s)'.format(w.ssid, bandName(w.band));
			if (w.disabled)
				add('warn', _('%s is disabled').format(name), '');
			if (w.s.ieee80211k != '1')
				add('error', _('802.11k is disabled on %s').format(name),
					_('Without it clients can\'t report how they hear the other access points, and roaming can\'t compare them.'),
					function() { uci.set('wireless', w.section, 'ieee80211k', '1'); });
			if (w.s.bss_transition != '1')
				add('error', _('802.11v (BSS transition) is disabled on %s').format(name),
					_('Without it clients can\'t be asked to move to a better access point.'),
					function() { uci.set('wireless', w.section, 'bss_transition', '1'); });
			if (!hasBssOption(w.s, 'notify_mgmt_frames'))
				add('warn', _('Management frame notifications are off on %s').format(name),
					_('prplMesh uses them to follow client association requests.'),
					function() { addBssOption(w.section, 'notify_mgmt_frames=1'); });
			if (w.encryption == 'none' || /wep/.test(w.encryption))
				add('warn', _('%s is not encrypted with WPA2/WPA3').format(name), '');
		});

		/* Backhaul */
		if (!backhauls.length) {
			add('error', _('There is no backhaul network'),
				_('Extenders connect to the router through a hidden backhaul network (Multi-AP backhaul BSS). Create it with the setup below.'));
		} else {
			backhauls.forEach(function(b) {
				var name = '%s (%s)'.format(b.ssid, bandName(b.band));
				if (b.disabled)
					add('error', _('Backhaul %s is disabled').format(name), '',
						function() { uci.unset('wireless', b.section, 'disabled'); });
				if (b.s.wds != '1')
					add('error', _('WDS is off on backhaul %s').format(name),
						_('Extenders bridge their clients over the backhaul: it needs 4-address (WDS) mode.'),
						function() { uci.set('wireless', b.section, 'wds', '1'); });
				if (b.s.hidden != '1')
					add('warn', _('Backhaul %s is visible').format(name),
						_('Clients see it and may try to connect. It is usually hidden.'),
						function() { uci.set('wireless', b.section, 'hidden', '1'); });
				if (!/psk2|sae/.test(b.encryption))
					add('error', _('Backhaul %s is not encrypted with WPA2/WPA3').format(name), '');
				else if (b.encryption == 'sae')
					add('warn', _('Backhaul %s is WPA3 only').format(name),
						_('Some extenders (e.g. TP-Link RE500X) only join a WPA2 backhaul.'));
			});
			var profile = false;
			uci.sections('prplmesh', 'bss_profile', function(p) {
				backhauls.forEach(function(b) { if (p.backhaul == '1' && p.ssid == b.ssid) profile = true; });
			});
			if (!profile)
				add('warn', _('The backhaul network has no EasyMesh profile'),
					_('The controller then can\'t give its credentials to the extenders. Run the setup below.'));
		}

		/* Onboarding with WPS */
		if (!st.onboarding.length) {
			add('warn', _('Extenders can\'t be added with WPS'),
				_('A mesh network on the backhaul band needs Multi-AP fronthaul+backhaul mode, the backhaul credentials and WPS push button. Run the setup below.'));
		} else {
			st.onboarding.forEach(function(w, i) {
				var name = '%s (%s)'.format(w.ssid, bandName(w.band));
				var bh = backhauls.filter(function(b) { return b.ssid == w.s.multi_ap_backhaul_ssid; })[0];
				if (!bh)
					add('error', _('%s hands out a backhaul network that doesn\'t exist').format(name),
						_('multi_ap_backhaul_ssid is "%s". Run the setup below.').format(w.s.multi_ap_backhaul_ssid || ''));
				else if (!w.ifname)
					add('info', _('WPS onboarding configured on %s').format(name),
						w.disabled ? _('The network is disabled.') : _('Its interface isn\'t known, so WPS can\'t be started from here (see above).'));
				else if (!st.wps[i])
					add('error', _('hostapd on %s does not answer WPS requests').format(name),
						_('The installed wpad/hostapd may lack WPS: install a full variant (e.g. wpad-mbedtls or wpad-openssl).'));
				else
					add('ok', _('WPS onboarding ready on %s').format(name),
						_('Extenders receive the backhaul network %s.').format(bh.ssid));
			});
		}

		/* prplMesh radios */
		var hostapdIfaces = {};
		st.sockets.forEach(function(n) { hostapdIfaces[n] = true; });
		uci.sections('prplmesh', 'wifi-device', function(r) {
			if (r.hostap_iface && !hostapdIfaces[r.hostap_iface])
				add('error', _('prplMesh radio %s uses %s, which doesn\'t exist').format(r['.name'], r.hostap_iface),
					_('The agent doesn\'t manage that radio. Run the setup below.'));
		});
		String(uci.get('prplmesh', 'config', 'mandatory_interfaces') || '').split(/\s*,\s*/).forEach(function(i) {
			if (i && !hostapdIfaces[i])
				add('error', _('Required interface %s doesn\'t exist').format(i),
					_('The agent waits for it and never starts. Run the setup below.'));
		});

		/* Mesh */
		if (st.nodes.length) {
			var extenders = 0;
			st.nodes.forEach(function(n) { if (!n.gateway) extenders++; });
			add(extenders ? 'ok' : 'info',
				extenders ? _('%d extender(s) connected').format(extenders) : _('No extender connected yet'),
				extenders ? '' : _('Add one with the WPS button below.'));
		}

		return list;
	},

	/* Checks of an extender (agent only). */
	agentChecks: function(st) {
		var list = [];
		var add = function(level, title, detail, fix) {
			list.push({ level: level, title: title, detail: detail, fix: fix });
		};
		var instances = L.isObject(st.services.prplmesh) ? (st.services.prplmesh.instances || {}) : {};
		var sockets = {};
		st.sockets.forEach(function(n) { sockets[n] = true; });

		if (uci.get('prplmesh', 'config', 'enabled') != '1')
			add('error', _('EasyMesh is disabled'), _('Run the setup below.'),
				function() { uci.set('prplmesh', 'config', 'enabled', '1'); });
		else if (!instances.agent || !instances.agent.running)
			add('error', _('The prplMesh agent is not running'), _('Check the system log (prplmesh).'));
		else
			add('ok', _('prplMesh agent is running'), _('This device is an extender: the main router configures its WiFi networks.'));

		if (!st.statusOk)
			add('warn', _('The WiFi status can\'t be read'),
				_('After updating this app, log out of LuCI and in again (its permissions are granted at login).'));

		/* Network: the main router is the only DHCP server and gateway */
		if (uci.get('dhcp', 'lan') && uci.get('dhcp', 'lan', 'ignore') != '1')
			add('error', _('This extender runs a DHCP server on its LAN'),
				_('Only the main router may hand out addresses, or clients get wrong ones.'),
				function() {
					uci.set('dhcp', 'lan', 'ignore', '1');
					uci.set('dhcp', 'lan', 'dhcpv6', 'disabled');
					uci.set('dhcp', 'lan', 'ra', 'disabled');
				});
		if (uci.get('network', 'lan', 'proto') == 'static')
			add('warn', _('The LAN has a fixed address'),
				_('Make sure it is free in the main router\'s network, or let the main router give it one. After applying that, this page is at the address the main router assigns.'),
				function() {
					uci.set('network', 'lan', 'proto', 'dhcp');
					['ipaddr', 'netmask', 'gateway', 'dns', 'ip6assign'].forEach(function(o) { uci.unset('network', 'lan', o); });
				});

		/* Radios: an access point prplMesh manages on each */
		var devices = uci.sections('wireless', 'wifi-device');
		devices.forEach(function(d) {
			var managed = st.ifaces.filter(function(w) { return w.device == d['.name'] && w.mode == 'ap' && w.s.prplmesh == '1'; });
			if (!managed.length)
				add('error', _('No access point managed by EasyMesh on %s').format(bandName(d.band)),
					_('The main router configures the networks on access points created for it. Run the setup below.'));
			else if (managed.every(function(w) { return w.disabled; }))
				add('warn', _('The EasyMesh access points of %s are disabled').format(bandName(d.band)),
					_('They are enabled when the main router sends the networks.'));
		});
		uci.sections('prplmesh', 'wifi-device', function(r) {
			if (r.hostap_iface && !sockets[r.hostap_iface])
				add('error', _('prplMesh radio %s uses %s, which doesn\'t exist').format(r['.name'], r.hostap_iface),
					_('Apply the setup (Save & Apply) or run it again.'));
		});

		/* Backhaul */
		var bsta = st.ifaces.filter(function(w) { return w.mode == 'sta' && w.multi_ap == '1' && !w.disabled; })[0];
		if (bsta) {
			if (!bsta.ssid || !uci.get('wireless', bsta.section, 'key'))
				add('error', _('The WiFi backhaul has no network or password'),
					_('Enter the backhaul network shown on the main router\'s setup page.'));
			else
				add('ok', _('WiFi backhaul to %s (%s)').format(bsta.ssid, bandName(bsta.band)),
					bsta.ifname ? _('Interface %s.').format(bsta.ifname) : _('Not up yet.'));
		} else {
			add('info', _('Wired backhaul'), _('Connect a LAN port of this extender to the main router (or another extender).'));
		}

		return list;
	},

	renderChecks: function(st) {
		var self = this;
		var icons = { ok: ['✔', 'green'], info: ['ℹ', '#06c'], warn: ['⚠', '#c80'], error: ['✖', '#c00'] };
		var checks = this.checks(st);
		var fixable = checks.filter(function(c) { return c.fix; });

		var rows = checks.map(function(c) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td', 'style': 'width:2em;color:' + icons[c.level][1] + ';font-weight:bold' }, icons[c.level][0]),
				E('td', { 'class': 'td left' }, [ E('strong', c.title), c.detail ? E('br') : '', c.detail ? E('small', c.detail) : '' ]),
				E('td', { 'class': 'td right' }, c.fix ? E('button', {
					'class': 'btn cbi-button cbi-button-apply',
					'click': ui.createHandlerFn(self, function() {
						c.fix();
						return self.staged();
					})
				}, _('Fix')) : '')
			]);
		});

		return E('div', { 'class': 'cbi-section' }, [
			E('h3', _('Checks')),
			E('table', { 'class': 'table' }, rows),
			fixable.length > 1 ? E('div', { 'class': 'right' }, E('button', {
				'class': 'btn cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(self, function() {
					fixable.forEach(function(c) { c.fix(); });
					return self.staged();
				})
			}, _('Fix all'))) : ''
		]);
	},

	staged: function() {
		ui.addNotification(null, E('p', _('Changes prepared. Review them with "Unsaved Changes" at the top and apply them with Save & Apply (WiFi restarts briefly).')), 'info');
		return uci.save().then(function() { return ui.changes.init(); }).then(L.bind(function() {
			return this.load().then(L.bind(function(st) {
				dom.content(document.getElementById('prplmesh-setup'), this.renderAll(st));
			}, this));
		}, this));
	},

	/* ---- Setup ------------------------------------------------------- */

	renderSetup: function(st) {
		var self = this;
		var controllerForm = this.renderControllerSetup(st);
		var agentForm = this.renderAgentSetup(st);
		var show = function(role) {
			controllerForm.style.display = role == 'agent' ? 'none' : '';
			agentForm.style.display = role == 'agent' ? '' : 'none';
		};
		var roleSelect = E('select', { 'class': 'cbi-input-select', 'change': function(ev) { show(ev.target.value); } }, [
			E('option', { 'value': 'controller', 'selected': st.role != 'agent' ? '' : null }, _('Main router (controller + agent)')),
			E('option', { 'value': 'agent', 'selected': st.role == 'agent' ? '' : null }, _('Extender (agent only)'))
		]);
		show(st.role);

		return E('div', { 'class': 'cbi-section' }, [
			E('h3', _('Easy setup')),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('This device is')),
				E('div', { 'class': 'cbi-value-field' }, [ roleSelect, E('div', { 'class': 'cbi-value-description' },
					_('One main router runs the controller and decides for the whole mesh; OpenWrt extenders only run the agent and get their networks from it.')) ])
			]),
			controllerForm,
			agentForm
		]);
	},

	renderControllerSetup: function(st) {
		var self = this;
		var aps = st.ifaces.filter(isFronthaulAp);
		var current = {};
		meshFronthauls(st.ifaces).forEach(function(w) { current[w.section] = true; });
		var anyCurrent = Object.keys(current).length > 0;
		var bands = {};
		st.ifaces.forEach(function(w) { bands[w.band] = true; });
		var existingBh = st.ifaces.filter(isBackhaul)[0];

		var boxes = aps.map(function(w) {
			var checked = anyCurrent ? !!current[w.section] : (w.s.network == 'lan' && !w.disabled);
			return E('div', {}, E('label', {}, [
				E('input', { 'type': 'checkbox', 'data-section': w.section, 'checked': checked ? '' : null }), ' ',
				'%s – %s (%s)%s'.format(w.ssid, bandName(w.band), w.section, w.s.network ? ', ' + w.s.network : '')
			]));
		});

		var bandSelect = E('select', { 'class': 'cbi-input-select' }, Object.keys(bands).filter(function(b) { return b; }).map(function(b) {
			var sel = existingBh ? existingBh.band == b : b == '5g';
			return E('option', { 'value': b, 'selected': sel ? '' : null }, bandName(b));
		}));
		var ssidInput = E('input', { 'class': 'cbi-input-text', 'type': 'text',
			'value': existingBh ? existingBh.ssid : '', 'placeholder': _('automatic (first network + "-BH")') });

		return E('div', {}, [
			E('p', { 'class': 'cbi-section-descr' },
				_('Pick the WiFi networks of the mesh: the extenders will broadcast them too and clients roam between all access points. The setup creates the hidden backhaul network (random password) if there is none, enables 802.11k/v, Multi-AP and WPS on the networks, and writes the EasyMesh configuration. Nothing is applied until you Save & Apply.')),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Mesh networks')),
				E('div', { 'class': 'cbi-value-field' }, boxes.length ? boxes : E('em', _('No access point network configured in Network → Wireless.')))
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Backhaul band')),
				E('div', { 'class': 'cbi-value-field' }, [ bandSelect, E('div', { 'class': 'cbi-value-description' },
					_('Band the extenders use to connect to the router. 5 GHz unless they are far away.')) ])
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Backhaul network name')),
				E('div', { 'class': 'cbi-value-field' }, ssidInput)
			]),
			E('div', { 'class': 'right' }, E('button', {
				'class': 'btn cbi-button cbi-button-action important',
				'click': ui.createHandlerFn(self, function() {
					var picked = [];
					boxes.forEach(function(b) {
						var input = b.querySelector('input');
						if (input.checked)
							picked.push(input.getAttribute('data-section'));
					});
					if (!picked.length) {
						ui.addNotification(null, E('p', _('Pick at least one network.')), 'warning');
						return;
					}
					self.prepare(st, picked, bandSelect.value, ssidInput.value.trim());
					return self.staged();
				})
			}, _('Prepare configuration')))
		]);
	},

	prepare: function(st, picked, bhBand, bhSsid) {
		var bySection = {};
		st.ifaces.forEach(function(w) { bySection[w.section] = w; });
		var fronthauls = picked.map(function(s) { return bySection[s]; });
		var radioOf = {};
		uci.sections('wireless', 'wifi-device', function(d) { radioOf[d.band] = radioOf[d.band] || d['.name']; });

		/* Backhaul network: the existing one on that band, else a new one. */
		var bh = st.ifaces.filter(function(w) { return isBackhaul(w) && w.band == bhBand; })[0];
		var bhSection, bhKey;
		if (bh) {
			bhSection = bh.section;
			if (bhSsid)
				setIf('wireless', bhSection, 'ssid', bhSsid);
			bhSsid = bhSsid || bh.ssid;
			bhKey = uci.get('wireless', bhSection, 'key');
			if (!bhKey) {
				bhKey = randomKey();
				setIf('wireless', bhSection, 'key', bhKey);
			}
		} else {
			bhSsid = bhSsid || (fronthauls[0].ssid.replace(/-5G$/i, '') + '-BH');
			bhKey = randomKey();
			bhSection = uci.add('wireless', 'wifi-iface', 'mesh_bh_' + bhBand);
			setIf('wireless', bhSection, 'device', radioOf[bhBand]);
			setIf('wireless', bhSection, 'mode', 'ap');
			setIf('wireless', bhSection, 'network', fronthauls[0].s.network || 'lan');
			setIf('wireless', bhSection, 'ssid', bhSsid);
			setIf('wireless', bhSection, 'key', bhKey);
		}
		/* WPA2: extenders like the RE500X don't join a WPA3 backhaul. */
		setIf('wireless', bhSection, 'encryption', 'psk2+ccmp');
		setIf('wireless', bhSection, 'hidden', '1');
		setIf('wireless', bhSection, 'multi_ap', '1');
		setIf('wireless', bhSection, 'wds', '1');
		if (uci.get('wireless', bhSection, 'disabled') != null)
			uci.unset('wireless', bhSection, 'disabled');
		addBssOption(bhSection, 'notify_mgmt_frames=1');

		/* Mesh networks: 11k/v, management frames; on the backhaul band they
		 * also onboard extenders (Multi-AP fronthaul+backhaul with WPS). */
		fronthauls.forEach(function(w) {
			setIf('wireless', w.section, 'ieee80211k', '1');
			setIf('wireless', w.section, 'bss_transition', '1');
			addBssOption(w.section, 'notify_mgmt_frames=1');
			if (w.band == bhBand) {
				setIf('wireless', w.section, 'multi_ap', '2');
				setIf('wireless', w.section, 'wps_pushbutton', '1');
				setIf('wireless', w.section, 'multi_ap_backhaul_ssid', bhSsid);
				setIf('wireless', w.section, 'multi_ap_backhaul_key', bhKey);
				addBssOption(w.section, 'multi_ap_profile=2');
			}
		});

		/* EasyMesh network profiles: update the existing ones in place (same
		 * network, band and role), add the missing ones, drop the others. */
		var wanted = [];
		fronthauls.forEach(function(w) {
			if (!wanted.some(function(x) { return x.ssid == w.ssid && x.band == w.band && x.fronthaul; }))
				wanted.push({ ssid: w.ssid, band: w.band, fronthaul: true,
					encryption: w.encryption.replace(/\+.*$/, ''),
					key: uci.get('wireless', w.section, 'key') });
		});
		wanted.push({ ssid: bhSsid, band: bhBand, fronthaul: false, encryption: 'psk2', key: bhKey });

		var used = {};
		wanted.forEach(function(x) {
			var sid = null;
			uci.sections('prplmesh', 'bss_profile', function(p) {
				var role = (p.fronthaul != '0') == x.fronthaul && (p.backhaul == '1') == !x.fronthaul;
				var bands = String(p.bands || '').split(/\s+/);
				if (!sid && !used[p['.name']] && role &&
				    (p.ssid == x.ssid || (!x.fronthaul && bands.indexOf(x.band) >= 0)) &&
				    bands.indexOf(x.band) >= 0)
					sid = p['.name'];
			});
			if (!sid) {
				var name = (x.fronthaul ? 'fh' : 'bh') + x.band.replace(/g$/, '');
				sid = uci.add('prplmesh', 'bss_profile', uci.get('prplmesh', name) ? null : name);
			}
			used[sid] = true;
			var set = function(o, v) { setIf('prplmesh', sid, o, v); };
			set('ssid', x.ssid);
			set('encryption', x.encryption);
			if (x.key)
				set('key', x.key);
			set('bands', x.band);
			set('fronthaul', x.fronthaul ? '1' : '0');
			set('backhaul', x.fronthaul ? '0' : '1');
		});
		uci.sections('prplmesh', 'bss_profile', function(p) {
			if (!used[p['.name']])
				uci.remove('prplmesh', p['.name']);
		});
		setIf('prplmesh', 'config', 'use_explicit_bss_profiles', '1');

		/* prplMesh radios: one per radio with a mesh network */
		var mandatory = [];
		var byRadio = {};
		fronthauls.forEach(function(w) { (byRadio[w.device] = byRadio[w.device] || []).push(w); });
		uci.sections('prplmesh', 'wifi-device', function(r) {
			if (!byRadio[r['.name']])
				uci.remove('prplmesh', r['.name']);
		});
		Object.keys(byRadio).forEach(function(dev) {
			var list = byRadio[dev], main = list[0];
			var sid = uci.get('prplmesh', dev) ? dev : uci.add('prplmesh', 'wifi-device', dev);
			setIf('prplmesh', sid, 'wireless_device', dev);
			setIf('prplmesh', sid, 'wireless_section', main.section);
			if (main.ifname) {
				setIf('prplmesh', sid, 'hostap_iface', main.ifname);
				setIf('prplmesh', sid, 'hostap_iface_steer_vaps',
					list.map(function(w) { return w.ifname; }).filter(function(i) { return i; }).join(','));
				mandatory.push(main.ifname);
			}
		});
		if (mandatory.length)
			setIf('prplmesh', 'config', 'mandatory_interfaces', mandatory.sort().join(','));

		setIf('prplmesh', 'config', 'enabled', '1');
		if (!uci.get('prplmesh', 'config', 'management_mode'))
			setIf('prplmesh', 'config', 'management_mode', 'Multi-AP-Controller-and-Agent');
	},

	renderAgentSetup: function(st) {
		var self = this;
		var devices = uci.sections('wireless', 'wifi-device');
		var bsta = st.ifaces.filter(function(w) { return w.mode == 'sta' && w.multi_ap == '1'; })[0];
		var bhSelect = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': 'wired', 'selected': !bsta || bsta.disabled ? '' : null }, _('Cable to the main router'))
		].concat(devices.map(function(d) {
			return E('option', { 'value': d['.name'], 'selected': bsta && !bsta.disabled && bsta.device == d['.name'] ? '' : null },
				_('WiFi, %s').format(bandName(d.band)));
		})));
		var ssidInput = E('input', { 'class': 'cbi-input-text', 'type': 'text', 'value': bsta ? bsta.ssid : '' });
		var keyInput = E('input', { 'class': 'cbi-input-password', 'type': 'password',
			'value': bsta ? (uci.get('wireless', bsta.section, 'key') || '') : '' });

		return E('div', {}, [
			E('p', { 'class': 'cbi-section-descr' },
				_('Prepares this device as an extender: EasyMesh agent only, an access point on each radio for the networks the main router sends, and the backhaul to the main router. Turn off its DHCP server too (see the checks). Nothing is applied until you Save & Apply.')),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Backhaul')),
				E('div', { 'class': 'cbi-value-field' }, bhSelect)
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Backhaul network')),
				E('div', { 'class': 'cbi-value-field' }, [ ssidInput, E('div', { 'class': 'cbi-value-description' },
					_('For a WiFi backhaul: the backhaul network and password shown on the main router\'s setup page.')) ])
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Backhaul password')),
				E('div', { 'class': 'cbi-value-field' }, keyInput)
			]),
			E('div', { 'class': 'right' }, E('button', {
				'class': 'btn cbi-button cbi-button-action important',
				'click': ui.createHandlerFn(self, function() {
					var bh = bhSelect.value;
					if (bh != 'wired' && (!ssidInput.value.trim() || keyInput.value.length < 8)) {
						ui.addNotification(null, E('p', _('Enter the backhaul network and its password (8 characters or more).')), 'warning');
						return;
					}
					self.prepareAgent(st, bh, ssidInput.value.trim(), keyInput.value);
					return self.staged();
				})
			}, _('Prepare configuration')))
		]);
	},

	/* Extender: agent only, a managed access point per radio, backhaul. */
	prepareAgent: function(st, bh, bhSsid, bhKey) {
		var devices = uci.sections('wireless', 'wifi-device');
		var bandOf = {};
		devices.forEach(function(d) { bandOf[d['.name']] = d.band; });

		setIf('prplmesh', 'config', 'enabled', '1');
		setIf('prplmesh', 'config', 'management_mode', 'Multi-AP-Agent');
		setIf('prplmesh', 'config', 'backhaul_wire_iface', 'br-lan');
		setIf('prplmesh', 'config', 'backhaul_band',
			bh == 'wired' ? 'auto' : ({ '2g': '2.4GHz', '5g': '5GHz', '6g': '6GHz' }[bandOf[bh]] || 'auto'));

		/* Backhaul station */
		var bsta = st.ifaces.filter(function(w) { return w.mode == 'sta' && w.multi_ap == '1'; })[0];
		var staIface = 'pm-bsta';
		if (bh == 'wired') {
			if (bsta)
				setIf('wireless', bsta.section, 'disabled', '1');
		} else {
			var sid = bsta ? bsta.section : uci.add('wireless', 'wifi-iface', 'pm_bsta');
			setIf('wireless', sid, 'device', bh);
			setIf('wireless', sid, 'mode', 'sta');
			setIf('wireless', sid, 'network', 'lan');
			setIf('wireless', sid, 'ifname', staIface);
			setIf('wireless', sid, 'ssid', bhSsid);
			setIf('wireless', sid, 'encryption', 'psk2');
			setIf('wireless', sid, 'key', bhKey);
			setIf('wireless', sid, 'multi_ap', '1');
			setIf('wireless', sid, 'wds', '1');
			setIf('wireless', sid, 'prplmesh', '1');
			if (uci.get('wireless', sid, 'disabled') != null)
				uci.unset('wireless', sid, 'disabled');
		}

		/* An access point managed by EasyMesh on each radio: the main router
		 * sends the networks, the agent keeps them in these sections. */
		var mandatory = [];
		uci.sections('prplmesh', 'wifi-device', function(r) {
			if (!bandOf[r['.name']])
				uci.remove('prplmesh', r['.name']);
		});
		devices.forEach(function(d) {
			var dev = d['.name'];
			var ap = st.ifaces.filter(function(w) { return w.device == dev && w.mode == 'ap' && w.s.prplmesh == '1'; })[0];
			var apSid = ap ? ap.section : uci.add('wireless', 'wifi-iface', 'pm_' + dev + '_ap');
			var apIface = (ap && ap.s.ifname) || ('pm-' + dev + '-ap');
			if (!ap) {
				uci.set('wireless', apSid, 'device', dev);
				uci.set('wireless', apSid, 'mode', 'ap');
				uci.set('wireless', apSid, 'network', 'lan');
				uci.set('wireless', apSid, 'ssid', 'EasyMesh-' + dev);
				uci.set('wireless', apSid, 'encryption', 'psk2');
				uci.set('wireless', apSid, 'key', randomKey());
				uci.set('wireless', apSid, 'hidden', '1');
				uci.set('wireless', apSid, 'prplmesh', '1');
			}
			setIf('wireless', apSid, 'ifname', apIface);
			if (uci.get('wireless', dev, 'disabled') != null)
				uci.unset('wireless', dev, 'disabled');

			var rid = uci.get('prplmesh', dev) ? dev : uci.add('prplmesh', 'wifi-device', dev);
			setIf('prplmesh', rid, 'wireless_device', dev);
			setIf('prplmesh', rid, 'wireless_section', apSid);
			setIf('prplmesh', rid, 'hostap_iface', apIface);
			setIf('prplmesh', rid, 'hostap_iface_steer_vaps', apIface);
			if (bh == dev)
				setIf('prplmesh', rid, 'sta_iface', staIface);
			else if (uci.get('prplmesh', rid, 'sta_iface') != null)
				uci.unset('prplmesh', rid, 'sta_iface');
			mandatory.push(apIface);
		});
		setIf('prplmesh', 'config', 'mandatory_interfaces', mandatory.sort().join(','));
	},

	/* ---- WPS ----------------------------------------------------------- */

	renderWps: function(st) {
		var self = this;
		if (st.role == 'agent')
			return E('div', { 'class': 'cbi-section' }, [
				E('h3', _('Join the mesh')),
				E('p', { 'class': 'cbi-section-descr' },
					_('With a cable backhaul it joins on its own once applied. With a WiFi backhaul, enter the backhaul network shown on the main router\'s setup page above; it then connects and gets the networks from the main router.'))
			]);
		var bh = st.ifaces.filter(isBackhaul)[0];
		var keyCell = E('code', {}, '••••••••');
		var creds = bh ? E('p', {}, [
			_('For OpenWrt extenders with a WiFi backhaul: network '), E('code', {}, bh.ssid), _(', password '), keyCell, ' ',
			E('button', { 'class': 'btn cbi-button', 'click': function(ev) {
				keyCell.textContent = uci.get('wireless', bh.section, 'key') || '';
				ev.target.remove();
			} }, _('Show'))
		]) : '';
		var ready = st.onboarding.filter(function(w, i) { return w.ifname && st.wps[i]; });
		var statusLine = E('span', { 'id': 'prplmesh-wps-status' },
			ready.map(function(w) {
				var s = st.wps[st.onboarding.indexOf(w)] || {};
				return '%s: %s'.format(w.ifname, s.pbc_status || '?');
			}).join(', '));

		return E('div', { 'class': 'cbi-section' }, [
			E('h3', _('Add an extender')),
			E('p', { 'class': 'cbi-section-descr' },
				_('Press WPS here, then the WPS button of the extender within 2 minutes. It receives the backhaul network, connects and joins the mesh (the networks are configured by the controller). Useful when the router has no WPS button or it doesn\'t work.')),
			ready.length ? E('div', {}, [
				E('button', {
					'class': 'btn cbi-button cbi-button-action important',
					'click': ui.createHandlerFn(self, function() {
						return Promise.all(ready.map(function(w) {
							return L.resolveDefault(hostapdCall(w.ifname, 'wps_start'), null);
						})).then(function() {
							ui.addNotification(null, E('p', _('WPS active for 2 minutes. Press the WPS button of the extender now.')), 'info');
							return self.pollWps(ready);
						});
					})
				}, _('Start WPS')), ' ',
				E('button', {
					'class': 'btn cbi-button',
					'click': ui.createHandlerFn(self, function() {
						return Promise.all(ready.map(function(w) {
							return L.resolveDefault(hostapdCall(w.ifname, 'wps_cancel'), null);
						})).then(function() { return self.pollWps(ready); });
					})
				}, _('Cancel')), ' ',
				E('small', {}, [ _('Status: '), statusLine ])
			]) : E('em', _('WPS onboarding isn\'t ready: see the checks above.')),
			creds
		]);
	},

	pollWps: function(ready) {
		return Promise.all(ready.map(function(w) {
			return L.resolveDefault(hostapdCall(w.ifname, 'wps_status'), {});
		})).then(function(res) {
			var el = document.getElementById('prplmesh-wps-status');
			if (el)
				el.textContent = ready.map(function(w, i) {
					var s = res[i] || {};
					return '%s: %s%s'.format(w.ifname, s.pbc_status || '?',
						s.last_wps_result ? ' (' + _('last: %s').format(s.last_wps_result) + ')' : '');
				}).join(', ');
		});
	},

	renderAll: function(st) {
		return E('div', {}, [
			this.renderChecks(st),
			this.renderSetup(st),
			this.renderWps(st)
		]);
	},

	render: function(st) {
		var container = E('div', { 'id': 'prplmesh-setup' }, this.renderAll(st));

		poll.add(L.bind(function() {
			var ready = st.onboarding.filter(function(w, i) { return w.ifname && st.wps[i]; });
			return ready.length ? this.pollWps(ready) : Promise.resolve();
		}, this), 5);

		return E('div', {}, [
			E('h2', _('EasyMesh setup')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Checks what EasyMesh needs, prepares the configuration of the main router or of an OpenWrt extender, and adds extenders with WPS.')),
			container
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
