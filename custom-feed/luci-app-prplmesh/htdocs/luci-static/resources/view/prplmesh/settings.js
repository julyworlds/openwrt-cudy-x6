'use strict';
'require view';
'require form';
'require fs';
'require uci';
'require tools.prplmesh as pm';

/* hostapd control sockets: one per BSS, named after the netdev */
function loadHostapdIfaces() {
	return L.resolveDefault(fs.list('/var/run/hostapd'), []).then(function(entries) {
		return entries.filter(function(e) {
			return e.type == 'socket' && e.name != 'global';
		}).map(function(e) {
			return e.name;
		}).sort();
	});
}

function wifiIfaceLabel(s) {
	return '%s – %s (%s, %s)'.format(s['.name'], s.ssid || '?', s.device || '?', s.mode || '?');
}

return view.extend({
	load: function() {
		return Promise.all([
			loadHostapdIfaces(),
			uci.load('wireless'),
			/* agents of the mesh, for the per agent roaming thresholds */
			L.resolveDefault(fs.exec(pm.CLI, [ '-c', 'bml_conn_map' ]), null),
			/* thresholds in use, written by the controller */
			L.resolveDefault(fs.read('/tmp/prplmesh_roaming_thresholds.json'), '{}'),
			uci.load('prplmesh')
		]);
	},

	render: function(data) {
		var hostapdIfaces = data[0] || [];
		var agents = pm.parseConnMap(data[2] ? (data[2].stdout || '') : '');
		var thresholds = {};
		try { thresholds = JSON.parse(data[3] || '{}') || {}; } catch (e) {}
		var m, s, o, ss;

		m = new form.Map('prplmesh', _('EasyMesh settings'),
			_('Basic prplMesh (EasyMesh) configuration. The service is restarted automatically when the settings are applied.'));

		/* General */
		s = m.section(form.NamedSection, 'config', 'prplmesh', _('General'));
		s.tab('general', _('General'));
		s.tab('steering', _('Roaming / steering'));
		s.tab('channels', _('Channels'));
		s.tab('radios', _('Radios'));
		s.tab('networks', _('Networks (SSIDs)'));

		o = s.taboption('general', form.Flag, 'enabled', _('Enable EasyMesh'));
		o.rmempty = false;

		o = s.taboption('general', form.ListValue, 'management_mode', _('Role'),
			_('Main router: controller and agent. Satellite (OpenWrt extender): agent only.'));
		o.value('Multi-AP-Controller-and-Agent', _('Controller + agent (main router)'));
		o.value('Multi-AP-Controller', _('Controller only'));
		o.value('Multi-AP-Agent', _('Agent only (satellite)'));
		o.default = 'Multi-AP-Controller-and-Agent';
		o.rmempty = false; /* prplMesh reads it: LuCI drops values equal to the default */

		o = s.taboption('general', form.DynamicList, 'mandatory_interfaces', _('Required interfaces'),
			_('The agent waits for these hostapd interfaces before starting. Normally the interfaces of all radios below.'));
		hostapdIfaces.forEach(function(i) { o.value(i); });
		/* stored as a comma separated string */
		o.cfgvalue = function(section_id) {
			var v = uci.get('prplmesh', section_id, 'mandatory_interfaces');
			return v ? String(v).split(/\s*,\s*/).filter(function(x) { return x; }) : [];
		};
		o.write = function(section_id, value) {
			uci.set('prplmesh', section_id, 'mandatory_interfaces', L.toArray(value).join(','));
		};

		o = s.taboption('general', form.Value, 'backhaul_wire_iface', _('Wired backhaul / LAN bridge'));
		o.placeholder = 'br-lan';

		o = s.taboption('general', form.ListValue, 'backhaul_band', _('Wireless backhaul band'));
		o.value('auto', _('Automatic'));
		o.value('2.4GHz', '2.4 GHz');
		o.value('5GHz', '5 GHz');
		o.default = 'auto';
		o.rmempty = false; /* prplMesh reads it: LuCI drops values equal to the default */

		o = s.taboption('steering', form.Flag, 'client_roaming', _('Client steering'),
			_('Move clients to the access point with the best signal.'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('steering', form.Flag, 'client_11k_roaming', _('Use 802.11k measurements'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('steering', form.Flag, 'band_steering', _('Band steering'),
			_('Prefer 5 GHz for clients that support it.'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('steering', form.Flag, 'load_balancing', _('Load balancing'));
		o.default = '0';
		o.rmempty = false;

		o = s.taboption('steering', form.Flag, 'optimal_path_prefer_signal_strenght', _('Decide by signal strength'),
			_('Choose the access point with the strongest signal as measured by the client (802.11k). When disabled, an estimated PHY rate is compared instead, which depends on the client capabilities.'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('steering', form.Value, 'roaming_hysteresis_percent_bonus', _('Roaming hysteresis (%)'),
			_('Advantage given to the current access point so clients do not bounce. With signal strength it is a percentage of its signal: 10% is about 7 dB at -70 dBm.'));
		o.datatype = 'range(0,100)';
		o.placeholder = '10';

		o = s.taboption('steering', form.Flag, 'legacy_client_steering', _('Move clients without 802.11v by disconnecting them'),
			_('Clients that support 802.11v are asked to move and never disconnected. Those known not to support it are left alone; enable this to block them on their access point and disconnect them instead, so they reconnect to the better one (a short interruption).'));
		o.default = '0';
		o.rmempty = false;

		o = s.taboption('steering', form.Flag, 'agent_steering', _('Let other agents steer their clients'),
			_('For EasyMesh agents that are not prplMesh (for example a TP-Link extender). Disabled: the controller decides for their clients too, measuring them from this router. Enabled: the agent may move a client whose signal drops below the threshold below, to an access point it picks itself without measuring the others.'));
		o.enabled = '2';
		o.disabled = '0';
		o.default = '0';
		o.rmempty = false;

		o = s.taboption('steering', form.Value, 'agent_steering_threshold_dbm', _('Agent steering threshold (dBm)'),
			_('Signal below which such an agent may move a client. Keep it low (a poor signal), or the agent moves clients that are fine.'));
		o.datatype = 'range(-110,-1)';
		o.placeholder = '-75';
		o.depends('agent_steering', '2');

		/* Roaming threshold per agent: stored in "agent" sections (al_mac,
		 * roaming_threshold_dbm, roaming_threshold_24g_dbm); empty means the
		 * automatic value the controller derives from the mesh links. */
		o = s.taboption('steering', form.DummyValue, '_rt_title', _('Roaming threshold per agent'));
		o.default = '';
		o.description = _('Clients whose signal drops below the threshold of their agent are evaluated and may be moved to another one. By default it is automatic: the signal at which the agent hears its nearest other agent plus 4 dB, shown in each empty field. Type a value to use it instead; clear it to go back to the automatic one. The 2.4 GHz value follows the 5 GHz one (plus the band difference) unless set.');

		function agentSection(almac) {
			var sid = null;
			uci.sections('prplmesh', 'agent', function(a) {
				if (String(a.al_mac || '').toLowerCase() == almac)
					sid = a['.name'];
			});
			return sid;
		}

		function thresholdOption(almac, title, opt, auto) {
			var o = s.taboption('steering', form.Value, 'rt_%s_%s'.format(opt, almac.replace(/:/g, '')), title);
			o.datatype = 'range(-110,-1)';
			o.placeholder = (auto != null) ? _('%d (automatic)').format(auto) : _('automatic');
			o.cfgvalue = function() {
				var sid = agentSection(almac);
				return sid ? uci.get('prplmesh', sid, opt) : null;
			};
			o.write = function(section_id, value) {
				var sid = agentSection(almac);
				if (!sid) {
					sid = uci.add('prplmesh', 'agent');
					uci.set('prplmesh', sid, 'al_mac', almac);
				}
				uci.set('prplmesh', sid, opt, value);
			};
			o.remove = function() {
				var sid = agentSection(almac);
				if (!sid)
					return;
				uci.unset('prplmesh', sid, opt);
				if (!uci.get('prplmesh', sid, 'roaming_threshold_dbm') &&
				    !uci.get('prplmesh', sid, 'roaming_threshold_24g_dbm'))
					uci.remove('prplmesh', sid);
			};
			return o;
		}

		/* connected agents, then configured ones that are not connected now */
		var listed = {};
		agents.forEach(function(a) {
			listed[a.almac.toLowerCase()] = a.gateway ? _('Router (controller)') : a.name;
		});
		uci.sections('prplmesh', 'agent', function(a) {
			var mac = String(a.al_mac || '').toLowerCase();
			if (mac && !(mac in listed))
				listed[mac] = _('not connected');
		});
		Object.keys(listed).forEach(function(mac) {
			var t = thresholds[mac] || {};
			var name = '%s (%s)'.format(listed[mac], mac);
			thresholdOption(mac, _('%s – 5/6 GHz (dBm)').format(name), 'roaming_threshold_dbm', t.auto_dbm);
			thresholdOption(mac, _('%s – 2.4 GHz (dBm)').format(name), 'roaming_threshold_24g_dbm', t.auto_24g_dbm);
		});

		o = s.taboption('channels', form.Flag, 'channel_select_task_enabled', _('Automatic channel selection'),
			_('Lets the controller change channels and transmit power. Disable it to keep the channels set in Wireless.'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('channels', form.Flag, 'dfs_task_enabled', _('DFS channel handling'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('channels', form.Flag, 'dfs_reentry', _('Return to DFS channels'));
		o.default = '1';
		o.rmempty = false;

		/* Radios */
		o = s.taboption('radios', form.SectionValue, '_radios', form.TypedSection, 'wifi-device', _('Radios'),
			_('Which hostapd interface prplMesh manages on each radio. Any name works (for example phy1-ap0 or wlan1); it no longer has to be renamed to wlanN.'));
		ss = o.subsection;
		ss.anonymous = false;
		ss.addremove = true;
		ss.addbtntitle = _('Add radio');

		o = ss.option(form.ListValue, 'wireless_device', _('Radio'));
		uci.sections('wireless', 'wifi-device').forEach(function(d) {
			o.value(d['.name'], '%s (%s)'.format(d['.name'], d.band || d.hwmode || '?'));
		});

		o = ss.option(form.Value, 'hostap_iface', _('Interface'),
			_('Main hostapd interface of this radio.'));
		hostapdIfaces.forEach(function(i) { o.value(i); });
		o.rmempty = false;

		o = ss.option(form.ListValue, 'wireless_section', _('Wireless network'),
			_('The wireless section (Network → Wireless) behind that interface.'));
		uci.sections('wireless', 'wifi-iface').forEach(function(w) {
			if (w.mode == 'ap')
				o.value(w['.name'], wifiIfaceLabel(w));
		});

		/* plain option string (comma separated), not a UCI list */
		o = ss.option(form.Value, 'hostap_iface_steer_vaps', _('Steerable interfaces'),
			_('Comma separated interfaces on which clients may be steered. Usually the same as Interface.'));
		hostapdIfaces.forEach(function(i) { o.value(i); });

		/* BSS profiles */
		o = s.taboption('networks', form.SectionValue, '_networks', form.TypedSection, 'bss_profile', _('Networks (SSIDs)'),
			_('Networks the controller configures on every node of the mesh. Fronthaul is for clients; backhaul links the nodes (usually hidden, 5 GHz).'));
		ss = o.subsection;
		ss.anonymous = false;
		ss.addremove = true;
		ss.addbtntitle = _('Add network');

		o = ss.option(form.Value, 'ssid', _('SSID'));
		o.rmempty = false;

		o = ss.option(form.ListValue, 'encryption', _('Encryption'));
		o.value('psk2', 'WPA2-PSK');
		o.value('sae-mixed', 'WPA2/WPA3 (mixed)');
		o.value('sae', 'WPA3-SAE');
		o.default = 'sae-mixed';
		o.rmempty = false; /* prplMesh reads it: LuCI drops values equal to the default */

		o = ss.option(form.Value, 'key', _('Password'));
		o.password = true;
		o.datatype = 'wpakey';
		o.modalonly = true;

		o = ss.option(form.MultiValue, 'bands', _('Bands'));
		o.value('2g', '2.4 GHz');
		o.value('5g', '5 GHz');
		o.value('6g', '6 GHz');
		/* stored as a space separated string, not a UCI list */
		o.cfgvalue = function(section_id) {
			var v = uci.get('prplmesh', section_id, 'bands');
			return v ? String(v).split(/\s+/) : [];
		};
		o.write = function(section_id, value) {
			uci.set('prplmesh', section_id, 'bands', L.toArray(value).join(' '));
		};

		o = ss.option(form.Flag, 'fronthaul', _('Fronthaul'));
		o.default = '1';
		o.rmempty = false;

		o = ss.option(form.Flag, 'backhaul', _('Backhaul'));
		o.default = '0';
		o.rmempty = false;

		return m.render();
	}
});
