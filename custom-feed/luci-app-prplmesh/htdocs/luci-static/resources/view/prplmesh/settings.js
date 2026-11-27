'use strict';
'require view';
'require form';
'require fs';
'require uci';

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
			uci.load('wireless')
		]);
	},

	render: function(data) {
		var hostapdIfaces = data[0] || [];
		var m, s, o;

		m = new form.Map('prplmesh', _('EasyMesh settings'),
			_('Basic prplMesh (EasyMesh) configuration. The service is restarted automatically when the settings are applied.'));

		/* General */
		s = m.section(form.NamedSection, 'config', 'prplmesh', _('General'));
		s.tab('general', _('General'));
		s.tab('steering', _('Roaming / steering'));
		s.tab('channels', _('Channels'));

		o = s.taboption('general', form.Flag, 'enabled', _('Enable EasyMesh'));
		o.rmempty = false;

		o = s.taboption('general', form.ListValue, 'management_mode', _('Role'),
			_('Main router: controller and agent. Satellite (OpenWrt extender): agent only.'));
		o.value('Multi-AP-Controller-and-Agent', _('Controller + agent (main router)'));
		o.value('Multi-AP-Controller', _('Controller only'));
		o.value('Multi-AP-Agent', _('Agent only (satellite)'));
		o.default = 'Multi-AP-Controller-and-Agent';

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

		o = s.taboption('steering', form.Value, 'roaming_hysteresis_percent_bonus', _('Roaming hysteresis (%)'),
			_('How much better the target has to be before a client is moved.'));
		o.datatype = 'range(0,100)';
		o.placeholder = '10';

		o = s.taboption('steering', form.Value, 'steering_disassoc_timer_msec', _('Disassociation timer (ms)'));
		o.datatype = 'uinteger';
		o.placeholder = '200';

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
		s = m.section(form.TypedSection, 'wifi-device', _('Radios'),
			_('Which hostapd interface prplMesh manages on each radio. Any name works (for example phy1-ap0 or wlan1); it no longer has to be renamed to wlanN.'));
		s.anonymous = false;
		s.addremove = true;
		s.addbtntitle = _('Add radio');

		o = s.option(form.ListValue, 'wireless_device', _('Radio'));
		uci.sections('wireless', 'wifi-device').forEach(function(d) {
			o.value(d['.name'], '%s (%s)'.format(d['.name'], d.band || d.hwmode || '?'));
		});

		o = s.option(form.Value, 'hostap_iface', _('Interface'),
			_('Main hostapd interface of this radio.'));
		hostapdIfaces.forEach(function(i) { o.value(i); });
		o.rmempty = false;

		o = s.option(form.ListValue, 'wireless_section', _('Wireless network'),
			_('The wireless section (Network → Wireless) behind that interface.'));
		uci.sections('wireless', 'wifi-iface').forEach(function(w) {
			if (w.mode == 'ap')
				o.value(w['.name'], wifiIfaceLabel(w));
		});

		/* plain option string (comma separated), not a UCI list */
		o = s.option(form.Value, 'hostap_iface_steer_vaps', _('Steerable interfaces'),
			_('Comma separated interfaces on which clients may be steered. Usually the same as Interface.'));
		hostapdIfaces.forEach(function(i) { o.value(i); });

		/* BSS profiles */
		s = m.section(form.TypedSection, 'bss_profile', _('Networks (SSIDs)'),
			_('Networks the controller configures on every node of the mesh. Fronthaul is for clients; backhaul links the nodes (usually hidden, 5 GHz).'));
		s.anonymous = false;
		s.addremove = true;
		s.addbtntitle = _('Add network');

		o = s.option(form.Value, 'ssid', _('SSID'));
		o.rmempty = false;

		o = s.option(form.ListValue, 'encryption', _('Encryption'));
		o.value('psk2', 'WPA2-PSK');
		o.value('sae-mixed', 'WPA2/WPA3 (mixed)');
		o.value('sae', 'WPA3-SAE');
		o.default = 'sae-mixed';

		o = s.option(form.Value, 'key', _('Password'));
		o.password = true;
		o.datatype = 'wpakey';
		o.modalonly = true;

		o = s.option(form.MultiValue, 'bands', _('Bands'));
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

		o = s.option(form.Flag, 'fronthaul', _('Fronthaul'));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Flag, 'backhaul', _('Backhaul'));
		o.default = '0';
		o.rmempty = false;

		return m.render();
	}
});
