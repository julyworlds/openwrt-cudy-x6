'use strict';
'require view';
'require poll';
'require dom';
'require tools.prplmesh as pm';

return view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(pm.callServiceList('prplmesh'), {}),
			pm.loadMap()
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
		if (!nodes.length)
			return E('div', { 'class': 'cbi-section' }, [
				E('h3', _('Topology')),
				E('p', { 'class': 'cbi-section-descr' },
					_('No topology available. Is the prplMesh controller running?'))
			]);

		return E('div', {}, nodes.map(function(node) {
			var rows = [];

			node.radios.forEach(function(radio) {
				radio.vaps.forEach(function(vap) {
					rows.push(E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td left' }, '%s, %s %d'.format(pm.bandOf(radio.freq), _('ch.'), radio.channel)),
						E('td', { 'class': 'td left' }, radio.bw),
						E('td', { 'class': 'td left' }, vap.ssid),
						E('td', { 'class': 'td left' }, vap.backhaul ? _('Backhaul') : _('Fronthaul')),
						E('td', { 'class': 'td left' }, vap.bssid),
						E('td', { 'class': 'td left' }, vap.ifname || '-')
					]));
				});
			});

			return E('div', { 'class': 'cbi-section' }, [
				E('h3', [
					pm.nodeTitle(node), ' ',
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
				].concat(rows))
			]);
		}));
	},

	renderAll: function(data) {
		var map = data[1], res = map.res, text = map.text;

		return E('div', {}, [
			this.renderService(data[0] || {}),
			this.renderNodes(map.nodes),
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
				_('Mesh topology as seen by the prplMesh controller. Connected devices are listed in the Clients tab.')),
			container
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
