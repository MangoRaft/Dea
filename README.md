Dea
===

A port of the dea from vcap


Example
===

```js
	var Agent = require('./')
	var raft = require('raft');
	var path = require('path');
	process.configPath = '/my-config-dir/config.json'
	raft.start()
	
	/**
	 *
	 *
	 *
	 */
	raft.nats.subscribe('dea.heartbeat', function(heartbeat) {
		console.log('dea.heartbeat droplet length', heartbeat.droplets.length)
	})
	raft.nats.subscribe('dea.start', function(info) {
		console.log('dea.start dea id', info.id)
	})
	raft.nats.subscribe('dea.advertise', function(info) {
		console.log('dea.advertise dea available_memory', info.available_memory, ' id ', info.id)
	})
	raft.nats.subscribe('droplet.exited', function(info) {
		console.log('droplet.exited state', info.reason)
	})
	raft.nats.subscribe('router.start', function(info) {
		console.log('router.start')
	})
	raft.nats.subscribe('router.register', function(info) {
		console.log('router.register')
	})
	raft.nats.subscribe('router.unregister', function(info) {
		console.log('router.unregister')
	})
	raft.nats.subscribe('router.usage', function(info) {
		console.log('router.usage:requests_per_sec', info.requests_per_sec)
	})
	var dropletId = raft.common.uuid(true)
	var run = function() {
	
		var sid1 = raft.nats.subscribe('dea.advertise', function(msg) {
			//console.log('dea.advertise', msg)
		})
		var replyEvent = 'dea.reply.' + raft.common.uuid(true)
		var sidreply = raft.nats.subscribe(replyEvent, function(msg) {
			raft.nats.unsubscribe(sidreply)
			sidreply = raft.nats.subscribe(replyEvent, function(msg) {
				console.log('raft.nats.subscribe', msg.state, msg.droplet_id, dropletId)
	
				//setTimeout(run, Math.random() * 1000)
				setTimeout(function() {
					//raft.nats.publish('dea.stop', msg)
				}, Math.random() * 1000)
			})
			setTimeout(function() {
	
				raft.nats.publish('dea.' + msg.id + '.start', {
					droplet : dropletId,
					index : 0,
					services : [],
					version : '1-1',
					sha1 : 'socketio_flot',
					executableFile : '???',
					executableUri : "/staged_droplets/#{droplet_id}/#{sha1}",
					name : 'socketio_flot',
					uris : ["localhost", "192.168.1.203"],
					env : [],
					users : ['drnicwilliams@gmail.com'],
					runtime_info : {
						name : 'ruby19',
						executable : 'ruby',
						version_output : 'ruby 1.9.3p286'
					},
					framework : '',
					running : 'node8',
					limits : {
						mem : 20
					},
					cc_partition : 'default'
				}, replyEvent)
			}, 1000)
		})
		setTimeout(function() {
			raft.nats.publish('dea.discover', {
				'runtime_info' : {
					'name' : 'ruby19',
					'executable' : 'ruby',
					'version_output' : 'ruby 1.9.3p286'
				},
				'limits' : {
					'mem' : 20
				},
				'droplet' : dropletId
			}, replyEvent)
		}, 1000)
	
	}
	run()


```