'use strict';
'require view';
'require poll';
'require dom';
'require ui';
'require tools.prplmesh as pm';

function capFlag(v) {
	if (v === true)
		return E('span', { 'style': 'color:green', 'title': _('Supported') }, '✓');
	if (v === false)
		return E('span', { 'style': 'color:#c00', 'title': _('Not supported') }, '✗');
	return E('span', { 'title': _('Unknown') }, '?');
}

return view.extend({
	load: function() {
		return Promise.all([
			pm.loadMap(),
			L.resolveDefault(pm.callDHCPLeases(), {})
		]);
	},

	/* All WiFi clients of the mesh in one table. Clients of a backhaul BSS
	 * are the extenders themselves and are left out. Names and addresses
	 * come from the DHCP leases (prplMesh rarely knows them). */
	renderClients: function(nodes, leases) {
		var targets = pm.fronthaulTargets(nodes), rows = [], byMac = {};

		(leases || []).forEach(function(l) {
			if (l.macaddr)
				byMac[l.macaddr.toLowerCase()] = l;
		});

		nodes.forEach(function(node) {
			node.radios.forEach(function(radio) {
				radio.vaps.forEach(function(vap) {
					if (vap.backhaul)
						return;

					vap.clients.forEach(function(client) {
						var lease = byMac[client.mac.toLowerCase()] || {};
						var rssi = (client.rssi != null && client.rssi > -127) ? client.rssi : null;
						var name = lease.hostname || client.name;
						var ip = lease.ipaddr ||
							(/^\d+\.\d+\.\d+\.\d+$/.test(client.ipv4) && client.ipv4 != '0.0.0.0' ? client.ipv4 : '-');
						var select = E('select', { 'class': 'cbi-input-select', 'style': 'width:auto;min-width:0' }, targets.filter(function(t) {
							return t.bssid != vap.bssid;
						}).map(function(t) {
							return E('option', { 'value': t.bssid }, t.label);
						}));

						rows.push(E('tr', { 'class': 'tr' }, [
							E('td', { 'class': 'td left' }, name ? [ name, E('br'), E('small', client.mac) ] : client.mac),
							E('td', { 'class': 'td left' }, ip),
							E('td', { 'class': 'td left' }, E('strong', node.gateway ? _('Router') : node.name)),
							E('td', { 'class': 'td left' }, '%s (%s)'.format(vap.ssid, pm.bandOf(radio.freq))),
							E('td', { 'class': 'td left' }, rssi ? '%d dBm'.format(rssi) : '-'),
							E('td', { 'class': 'td center' }, capFlag(client.k11)),
							E('td', { 'class': 'td center' }, capFlag(client.v11)),
							E('td', { 'class': 'td left' }, E('div', {
								'style': 'display:flex;flex-wrap:nowrap;align-items:center;gap:.5em'
							}, [
								select,
								E('button', {
									'class': 'cbi-button cbi-button-action',
									'click': ui.createHandlerFn(this, function() {
										return pm.steerClient(client.mac, select.value);
									})
								}, _('Move'))
							]))
						]));
					});
				});
			});
		});

		return E('div', { 'class': 'cbi-section' }, [
			E('h3', _('Clients')),
			rows.length ? E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, _('Client')),
					E('th', { 'class': 'th' }, _('IPv4')),
					E('th', { 'class': 'th' }, _('Access point')),
					E('th', { 'class': 'th' }, _('Network')),
					E('th', { 'class': 'th' }, _('Signal')),
					E('th', { 'class': 'th center', 'title': _('802.11k: the client can measure the other access points') }, '11k'),
					E('th', { 'class': 'th center', 'title': _('802.11v: the client accepts a request to move to another access point') }, '11v'),
					E('th', { 'class': 'th' }, _('Steer to'))
				])
			].concat(rows)) : E('p', { 'class': 'cbi-section-descr' },
				_('No clients reported yet. Clients that were already connected when EasyMesh started can take about a minute to appear.'))
		]);
	},

	renderAll: function(data) {
		var map = data[0];
		var leases = L.isObject(data[1]) ? data[1].dhcp_leases : null;

		if (!map.nodes.length)
			return E('div', { 'class': 'cbi-section' }, E('p', { 'class': 'cbi-section-descr' },
				_('No topology available. Is the prplMesh controller running?')));

		return this.renderClients(map.nodes, leases);
	},

	render: function(data) {
		var container = E('div', { 'id': 'prplmesh-clients' }, this.renderAll(data));

		poll.add(L.bind(function() {
			return this.load().then(L.bind(function(d) {
				// Do not redraw under a user picking a steering target.
				if (container.contains(document.activeElement) &&
				    document.activeElement.tagName == 'SELECT')
					return;

				dom.content(container, this.renderAll(d));
			}, this));
		}, this), 15);

		return E('div', {}, [
			E('h2', _('EasyMesh clients')),
			E('div', { 'class': 'cbi-map-descr' },
				_('WiFi devices connected to the mesh and the access point they use. "Move" asks the client to roam to another access point (802.11v BSS transition); the client may refuse.')),
			container
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
