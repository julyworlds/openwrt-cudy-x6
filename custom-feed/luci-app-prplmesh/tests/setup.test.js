'use strict';
/*
 * Tests of the EasyMesh setup page (checks and easy setup) without a router:
 * the LuCI view runs in node against simulated UCI configurations.
 *
 *   node --test custom-feed/luci-app-prplmesh/tests/setup.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const VIEW = path.join(__dirname, '../htdocs/luci-static/resources/view/prplmesh/setup.js');

/* ---- Simulated LuCI ---------------------------------------------------- */

function makeUci(config) {
	const conf = JSON.parse(JSON.stringify(config));
	const order = {};
	let n = 0;
	for (const c of Object.keys(conf))
		order[c] = Object.keys(conf[c]);
	return {
		conf,
		sections(c, t, cb) {
			const r = (order[c] || []).filter(s => conf[c][s] && (!t || conf[c][s]['.type'] == t))
				.map(s => Object.assign({ '.name': s }, conf[c][s]));
			if (cb) r.forEach(cb);
			return r;
		},
		get(c, s, o) {
			const x = (conf[c] || {})[s];
			if (!x) return null;
			if (o === undefined) return x;
			return x[o] === undefined ? null : x[o];
		},
		set(c, s, o, v) {
			if (!conf[c][s]) throw new Error('no section ' + c + '.' + s);
			conf[c][s][o] = v;
		},
		unset(c, s, o) { if (conf[c][s]) delete conf[c][s][o]; },
		add(c, t, name) {
			name = name || ('cfg' + (n++));
			if (conf[c][name]) throw new Error('section exists ' + c + '.' + name);
			conf[c][name] = { '.type': t };
			order[c].push(name);
			return name;
		},
		remove(c, s) { delete conf[c][s]; }
	};
}

function loadView(uci) {
	String.prototype.format = function(...a) { let i = 0; return this.replace(/%[sd]/g, () => String(a[i++])); };
	global.window = { crypto: { getRandomValues: b => { for (let i = 0; i < b.length; i++) b[i] = (i * 31 + 7) & 0xff; return b; } } };
	const L = {
		toArray: x => x == null ? [] : (Array.isArray(x) ? x : [x]),
		isObject: x => x && typeof x == 'object',
		bind: (f, t) => f.bind(t),
		resolveDefault: p => p
	};
	let src = fs.readFileSync(VIEW, 'utf8').replace(/^'require [^']*';$/mg, '').replace(/^'use strict';/m, '');
	src = src.replace(/^return view\.extend\(/m, 'module.exports = (');
	const mod = {};
	new Function('module', 'L', '_', 'uci', 'rpc', 'fs', 'pm', 'ui', 'dom', 'poll', 'E', 'view', src)(
		mod, L, s => s, uci, { declare: () => () => Promise.resolve({}) }, {}, { parseConnMap: () => [] },
		{}, {}, {}, () => null, {});
	const wirelessIfaces = new Function('uci', 'L', src.match(/function wirelessIfaces[\s\S]*?\n}\n/)[0] + 'return wirelessIfaces;')(uci, L);
	return { view: mod.exports, wirelessIfaces };
}

/* State the page loads: interfaces from netifd, hostapd sockets, services. */
function state(uci, wirelessIfaces, opts) {
	opts = opts || {};
	const status = {};
	for (const s of uci.sections('wireless', 'wifi-iface')) {
		const dev = s.device;
		(status[dev] = status[dev] || { interfaces: [] });
		if (s.disabled != '1' && opts.ifnames && opts.ifnames[s['.name']])
			status[dev].interfaces.push({ section: s['.name'], ifname: opts.ifnames[s['.name']] });
	}
	const ifaces = wirelessIfaces(status);
	const onboarding = ifaces.filter(w => w.mode == 'ap' && w.multi_ap != '1' && w.ifname &&
		w.s.wps_pushbutton == '1' && (w.multi_ap == '2' || w.multi_ap == '3'));
	return {
		role: uci.get('prplmesh', 'config', 'management_mode') == 'Multi-AP-Agent' ? 'agent' : 'controller',
		ifaces,
		sockets: Object.values(opts.ifnames || {}),
		services: { prplmesh: { instances: { agent: { running: true }, controller: { running: opts.controller !== false } } } },
		nodes: opts.nodes || [],
		onboarding,
		wps: onboarding.map(() => opts.wps === false ? null : { pbc_status: 'Disabled' })
	};
}

const levels = checks => checks.filter(c => c.level == 'error' || c.level == 'warn').map(c => c.title);

/* ---- Fixtures ---------------------------------------------------------- */

const radios = {
	radio0: { '.type': 'wifi-device', type: 'mac80211', band: '2g', channel: '11' },
	radio1: { '.type': 'wifi-device', type: 'mac80211', band: '5g', channel: '36' }
};

/* A main router configured for EasyMesh (as the Cudy X6 is). */
const configuredRouter = {
	wireless: Object.assign({}, radios, {
		ap5: { '.type': 'wifi-iface', device: 'radio1', mode: 'ap', network: 'lan', ssid: 'Home-5G', encryption: 'sae-mixed', key: 'k5',
			ieee80211k: '1', bss_transition: '1', multi_ap: '2', wps_pushbutton: '1',
			hostapd_bss_options: ['multi_ap_profile=2', 'notify_mgmt_frames=1'], multi_ap_backhaul_ssid: 'Home-BH', multi_ap_backhaul_key: 'kbh' },
		ap2: { '.type': 'wifi-iface', device: 'radio0', mode: 'ap', network: 'lan', ssid: 'Home', encryption: 'sae-mixed', key: 'k2',
			ieee80211k: '1', bss_transition: '1', hostapd_bss_options: ['notify_mgmt_frames=1'] },
		guest: { '.type': 'wifi-iface', device: 'radio0', mode: 'ap', network: 'guest', ssid: 'Guest', encryption: 'psk2', key: 'kg' },
		mesh_bh: { '.type': 'wifi-iface', device: 'radio1', mode: 'ap', network: 'lan', ssid: 'Home-BH', encryption: 'psk2+ccmp', key: 'kbh',
			hidden: '1', multi_ap: '1', wds: '1', hostapd_bss_options: ['notify_mgmt_frames=1'] }
	}),
	prplmesh: {
		config: { '.type': 'prplmesh', enabled: '1', management_mode: 'Multi-AP-Controller-and-Agent', mandatory_interfaces: 'phy0-ap0,phy1-ap0', use_explicit_bss_profiles: '1' },
		radio0: { '.type': 'wifi-device', hostap_iface: 'phy0-ap0', wireless_section: 'ap2', wireless_device: 'radio0', hostap_iface_steer_vaps: 'phy0-ap0' },
		radio1: { '.type': 'wifi-device', hostap_iface: 'phy1-ap0', wireless_section: 'ap5', wireless_device: 'radio1', hostap_iface_steer_vaps: 'phy1-ap0' },
		fh5: { '.type': 'bss_profile', ssid: 'Home-5G', encryption: 'sae-mixed', key: 'k5', bands: '5g', fronthaul: '1', backhaul: '0' },
		fh2: { '.type': 'bss_profile', ssid: 'Home', encryption: 'sae-mixed', key: 'k2', bands: '2g', fronthaul: '1', backhaul: '0' },
		bh5: { '.type': 'bss_profile', ssid: 'Home-BH', encryption: 'psk2', key: 'kbh', bands: '5g', fronthaul: '0', backhaul: '1' }
	},
	dhcp: { lan: { '.type': 'dhcp', interface: 'lan' } },
	network: { lan: { '.type': 'interface', proto: 'static', ipaddr: '192.168.2.1' } }
};
const routerIfnames = { ap2: 'phy0-ap0', guest: 'phy0-ap1', ap5: 'phy1-ap0', mesh_bh: 'phy1-ap1' };

/* A main router fresh out of the box, networks set by hand, no EasyMesh. */
const freshRouter = {
	wireless: Object.assign({}, radios, {
		ap5: { '.type': 'wifi-iface', device: 'radio1', mode: 'ap', network: 'lan', ssid: 'Home-5G', encryption: 'sae-mixed', key: 'k5' },
		ap2: { '.type': 'wifi-iface', device: 'radio0', mode: 'ap', network: 'lan', ssid: 'Home', encryption: 'psk2', key: 'k2' }
	}),
	prplmesh: { config: { '.type': 'prplmesh', enabled: '0' } },
	dhcp: { lan: { '.type': 'dhcp', interface: 'lan' } },
	network: { lan: { '.type': 'interface', proto: 'static', ipaddr: '192.168.1.1' } }
};

/* An OpenWrt device to become an extender: defaults, DHCP server on. */
const freshExtender = {
	wireless: Object.assign({}, radios, {
		default_radio0: { '.type': 'wifi-iface', device: 'radio0', mode: 'ap', network: 'lan', ssid: 'OpenWrt', encryption: 'none' },
		default_radio1: { '.type': 'wifi-iface', device: 'radio1', mode: 'ap', network: 'lan', ssid: 'OpenWrt', encryption: 'none' }
	}),
	prplmesh: { config: { '.type': 'prplmesh', enabled: '0' } },
	dhcp: { lan: { '.type': 'dhcp', interface: 'lan', start: '100' } },
	network: { lan: { '.type': 'interface', proto: 'static', ipaddr: '192.168.1.1' } }
};

/* ---- Main router -------------------------------------------------------- */

test('configured router: every check passes', () => {
	const uci = makeUci(configuredRouter);
	const { view, wirelessIfaces } = loadView(uci);
	assert.deepStrictEqual(levels(view.checks(state(uci, wirelessIfaces, { ifnames: routerIfnames, nodes: [{ gateway: true }, { gateway: false }] }))), []);
});

test('configured router: running the setup again changes nothing', () => {
	const uci = makeUci(configuredRouter);
	const { view, wirelessIfaces } = loadView(uci);
	const before = JSON.stringify(uci.conf);
	view.prepare(state(uci, wirelessIfaces, { ifnames: routerIfnames }), ['ap5', 'ap2'], '5g', '');
	assert.strictEqual(JSON.stringify(uci.conf), before);
});

test('router: what made EasyMesh fail is reported, with fixes', () => {
	const cfg = JSON.parse(JSON.stringify(configuredRouter));
	delete cfg.wireless.ap2.ieee80211k;
	delete cfg.wireless.ap5.bss_transition;
	cfg.wireless.mesh_bh.wds = '0';
	cfg.prplmesh.config.mandatory_interfaces = 'wlan0,phy1-ap0';
	const uci = makeUci(cfg);
	const { view, wirelessIfaces } = loadView(uci);
	const checks = view.checks(state(uci, wirelessIfaces, { ifnames: routerIfnames }));
	const titles = levels(checks);
	assert.ok(titles.some(t => /802.11k is disabled on Home \(2.4/.test(t)), titles);
	assert.ok(titles.some(t => /802.11v .* disabled on Home-5G/.test(t)), titles);
	assert.ok(titles.some(t => /WDS is off/.test(t)), titles);
	assert.ok(titles.some(t => /Required interface wlan0/.test(t)), titles);
	checks.filter(c => c.fix).forEach(c => c.fix());
	const after = levels(view.checks(state(uci, wirelessIfaces, { ifnames: routerIfnames })));
	assert.deepStrictEqual(after.filter(t => !/wlan0/.test(t)), []);
});

test('router: hostapd without WPS is reported', () => {
	const uci = makeUci(configuredRouter);
	const { view, wirelessIfaces } = loadView(uci);
	const titles = levels(view.checks(state(uci, wirelessIfaces, { ifnames: routerIfnames, wps: false })));
	assert.ok(titles.some(t => /does not answer WPS/.test(t)), titles);
});

test('router: WPA3-only backhaul is warned about', () => {
	const cfg = JSON.parse(JSON.stringify(configuredRouter));
	cfg.wireless.mesh_bh.encryption = 'sae';
	const uci = makeUci(cfg);
	const { view, wirelessIfaces } = loadView(uci);
	assert.ok(levels(view.checks(state(uci, wirelessIfaces, { ifnames: routerIfnames }))).some(t => /WPA3 only/.test(t)));
});

test('fresh router: the setup creates the backhaul and configures everything', () => {
	const uci = makeUci(freshRouter);
	const { view, wirelessIfaces } = loadView(uci);
	const ifnames = { ap2: 'phy0-ap0', ap5: 'phy1-ap0' };
	const before = levels(view.checks(state(uci, wirelessIfaces, { ifnames })));
	assert.ok(before.some(t => /disabled/.test(t)));
	assert.ok(before.some(t => /no backhaul network/.test(t)));

	view.prepare(state(uci, wirelessIfaces, { ifnames }), ['ap5', 'ap2'], '5g', '');
	const w = uci.conf.wireless, p = uci.conf.prplmesh;
	assert.strictEqual(w.mesh_bh_5g.ssid, 'Home-BH');
	assert.strictEqual(w.mesh_bh_5g.hidden, '1');
	assert.strictEqual(w.mesh_bh_5g.multi_ap, '1');
	assert.strictEqual(w.mesh_bh_5g.wds, '1');
	assert.strictEqual(w.mesh_bh_5g.encryption, 'psk2+ccmp');
	assert.ok(w.mesh_bh_5g.key.length >= 20);
	assert.strictEqual(w.ap5.multi_ap, '2');
	assert.strictEqual(w.ap5.wps_pushbutton, '1');
	assert.strictEqual(w.ap5.multi_ap_backhaul_ssid, 'Home-BH');
	assert.strictEqual(w.ap5.multi_ap_backhaul_key, w.mesh_bh_5g.key);
	for (const s of ['ap5', 'ap2']) {
		assert.strictEqual(w[s].ieee80211k, '1');
		assert.strictEqual(w[s].bss_transition, '1');
	}
	assert.strictEqual(w.ap2.multi_ap, undefined, 'only the backhaul band onboards');
	assert.strictEqual(p.config.enabled, '1');
	assert.strictEqual(p.config.mandatory_interfaces, 'phy0-ap0,phy1-ap0');
	assert.deepStrictEqual(Object.keys(p).filter(k => p[k]['.type'] == 'bss_profile').sort(), ['bh5', 'fh2', 'fh5']);
	assert.strictEqual(p.bh5.key, w.mesh_bh_5g.key);
	assert.strictEqual(p.radio1.hostap_iface, 'phy1-ap0');

	/* once applied, netifd creates the backhaul interface */
	ifnames.mesh_bh_5g = 'phy1-ap1';
	assert.deepStrictEqual(levels(view.checks(state(uci, wirelessIfaces, { ifnames }))), []);
});

test('router: networks left out of the mesh are not touched', () => {
	const uci = makeUci(configuredRouter);
	const { view, wirelessIfaces } = loadView(uci);
	const guest = JSON.stringify(uci.conf.wireless.guest);
	view.prepare(state(uci, wirelessIfaces, { ifnames: routerIfnames }), ['ap5', 'ap2'], '5g', '');
	assert.strictEqual(JSON.stringify(uci.conf.wireless.guest), guest);
});

/* ---- Extender (agent only) --------------------------------------------- */

test('fresh extender: DHCP server and missing access points are reported', () => {
	const cfg = JSON.parse(JSON.stringify(freshExtender));
	cfg.prplmesh.config.management_mode = 'Multi-AP-Agent';
	cfg.prplmesh.config.enabled = '1';
	const uci = makeUci(cfg);
	const { view, wirelessIfaces } = loadView(uci);
	const titles = levels(view.checks(state(uci, wirelessIfaces, { ifnames: { default_radio0: 'phy0-ap0', default_radio1: 'phy1-ap0' } })));
	assert.ok(titles.some(t => /DHCP server/.test(t)), titles);
	assert.ok(titles.some(t => /No access point managed by EasyMesh on 5 GHz/.test(t)), titles);
	assert.ok(titles.some(t => /fixed address/.test(t)), titles);
});

test('extender with WiFi backhaul: agent, access points and backhaul station', () => {
	const uci = makeUci(freshExtender);
	const { view, wirelessIfaces } = loadView(uci);
	view.prepareAgent(state(uci, wirelessIfaces, {}), 'radio1', 'Home-BH', 'backhaul-key');
	const w = uci.conf.wireless, p = uci.conf.prplmesh;

	assert.strictEqual(p.config.management_mode, 'Multi-AP-Agent');
	assert.strictEqual(p.config.backhaul_band, '5GHz');
	assert.strictEqual(w.pm_bsta.mode, 'sta');
	assert.strictEqual(w.pm_bsta.device, 'radio1');
	assert.strictEqual(w.pm_bsta.ssid, 'Home-BH');
	assert.strictEqual(w.pm_bsta.key, 'backhaul-key');
	assert.strictEqual(w.pm_bsta.multi_ap, '1');
	assert.strictEqual(w.pm_bsta.ifname, 'pm-bsta');
	for (const dev of ['radio0', 'radio1']) {
		const ap = w['pm_' + dev + '_ap'];
		assert.strictEqual(ap.mode, 'ap');
		assert.strictEqual(ap.prplmesh, '1', 'managed by EasyMesh');
		assert.strictEqual(ap.hidden, '1', 'placeholder not broadcast');
		assert.strictEqual(ap.ifname, 'pm-' + dev + '-ap');
		assert.strictEqual(p[dev].hostap_iface, 'pm-' + dev + '-ap');
		assert.strictEqual(p[dev].wireless_section, 'pm_' + dev + '_ap');
	}
	assert.strictEqual(p.radio1.sta_iface, 'pm-bsta');
	assert.strictEqual(p.radio0.sta_iface, undefined);
	assert.strictEqual(p.config.mandatory_interfaces, 'pm-radio0-ap,pm-radio1-ap');
	assert.strictEqual(JSON.stringify(w.default_radio0), JSON.stringify(freshExtender.wireless.default_radio0), 'user networks untouched');

	/* applied: interfaces up; fix the DHCP checks; everything passes */
	const ifnames = { pm_radio0_ap: 'pm-radio0-ap', pm_radio1_ap: 'pm-radio1-ap', pm_bsta: 'pm-bsta', default_radio0: 'phy0-ap0', default_radio1: 'phy1-ap0' };
	const checks = view.checks(state(uci, wirelessIfaces, { ifnames }));
	checks.filter(c => c.fix).forEach(c => c.fix());
	assert.strictEqual(uci.conf.dhcp.lan.ignore, '1');
	assert.strictEqual(uci.conf.network.lan.proto, 'dhcp');
	assert.deepStrictEqual(levels(view.checks(state(uci, wirelessIfaces, { ifnames }))), []);
});

test('extender: running the setup again changes nothing', () => {
	const uci = makeUci(freshExtender);
	const { view, wirelessIfaces } = loadView(uci);
	view.prepareAgent(state(uci, wirelessIfaces, {}), 'radio1', 'Home-BH', 'backhaul-key');
	const once = JSON.stringify(uci.conf);
	view.prepareAgent(state(uci, wirelessIfaces, {}), 'radio1', 'Home-BH', 'backhaul-key');
	assert.strictEqual(JSON.stringify(uci.conf), once);
});

test('extender: switching to a cable backhaul disables the station', () => {
	const uci = makeUci(freshExtender);
	const { view, wirelessIfaces } = loadView(uci);
	view.prepareAgent(state(uci, wirelessIfaces, {}), 'radio1', 'Home-BH', 'backhaul-key');
	view.prepareAgent(state(uci, wirelessIfaces, {}), 'wired', '', '');
	assert.strictEqual(uci.conf.wireless.pm_bsta.disabled, '1');
	assert.strictEqual(uci.conf.prplmesh.radio1.sta_iface, undefined);
	assert.strictEqual(uci.conf.prplmesh.config.backhaul_band, 'auto');
});

test('extender: networks sent by the controller keep their access points managed', () => {
	/* the agent rewrites the placeholder with the controller's network
	 * (prplMesh wifi_persist); the checks and a new setup run keep it */
	const uci = makeUci(freshExtender);
	const { view, wirelessIfaces } = loadView(uci);
	view.prepareAgent(state(uci, wirelessIfaces, {}), 'wired', '', '');
	Object.assign(uci.conf.wireless.pm_radio1_ap, { ssid: 'Home-5G', encryption: 'sae-mixed', key: 'k5', multi_ap: '2' });
	delete uci.conf.wireless.pm_radio1_ap.hidden;
	const once = JSON.stringify(uci.conf);
	view.prepareAgent(state(uci, wirelessIfaces, {}), 'wired', '', '');
	assert.strictEqual(JSON.stringify(uci.conf), once, 'the setup does not undo the controller\'s networks');
});
