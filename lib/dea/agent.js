/*
 *
 * (C) 2014, MangoRaft.
 *
 */
var util = require('util');
var fs = require('fs');
var net = require('net');
var path = require('path');
var events = require('events');
var os = require('os');
var raft = require('raft');
var Spawn = require('../../../Spawn');
var log = require('raft-logger');
var net = require('net');
var Socket = net.Socket;
var portfinder = require('portfinder');
/**
 *
 *
 */

const repos = {
	git : true,
	local : false,
	npm : false,
	tar : true,
	zip : false
};

const VERSION = require('../../package.json').version;
const DEFAULT_APP_MEM = 512;
//512MB
const DEFAULT_APP_DISK = 256;
//256MB
const DEFAULT_APP_NUM_FDS = 1024;

// Max limits for DEA
const DEFAULT_MAX_CLIENTS = 1024;

const MONITOR_INTERVAL = 2000;
// 2 secs
const MAX_USAGE_SAMPLES = (1 * 60000) / MONITOR_INTERVAL;
// 1 minutes this. 5 sec interval
const CRASHES_REAPER_INTERVAL = 30000;
// 30 secs
const CRASHES_REAPER_TIMEOUT = 3600000;
// delete crashes older than 1 hour

// CPU Thresholds
const BEGIN_RENICE_CPU_THRESHOLD = 50;
const MAX_RENICE_VALUE = 20;

const VARZ_UPDATE_INTERVAL = 1;
// 1 secs

const APP_STATE_FILE = 'applications.json';

const TAINT_MS_PER_APP = 10;
const TAINT_MS_FOR_MEM = 100;
const TAINT_MAX_DELAY = 250;

const DEFAULT_EVACUATION_DELAY = 30;
// Default time to wait (in secs) for evacuation and restart of apps.

const SECURE_USER = '///{Secure::SECURE_USER_STRING}/';

// How long to wait in between logging the structure of the apps directory in the event that a du takes excessively long
const APPS_DUMP_INTERVAL = 30 * 60000;

const DROPLET_FS_PERCENT_USED_THRESHOLD = 95;
const DROPLET_FS_PERCENT_USED_UPDATE_INTERVAL = 2;
const RUNTIME_VERSION_KEYS = '%w[version_flag version_output executable additional_checks]';

/**
 *
 *
 */
var Dea = module.exports = function(environment) {

	var config = raft.config.get('dea');

	events.EventEmitter.call(this);

	var uuid = this.uuid = raft.common.uuid(true);

	this.environment = environment || 'development';

	this.logs = {
		logger : log.Logger.createLogger(raft.config.get('logs:udp'))
	};

	this.log = this.logs.logger.create('raft', 'dea', raft.config.get('log_session'));

	this.secure = config['secure'];
	this.enforce_ulimit = config['enforce_ulimit'];

	this.droplets = {};
	this.usage = {};
	this.snapshot_scheduled = false;
	this.disable_dir_cleanup = config['disable_dir_cleanup'];

	this.downloads_pending = {};

	this.shutting_down = false;

	this.runtimes = {};
	this.runtime_names = config['runtimes'] || [];

	if (Array.isArray(this.runtime_names)) {
		this.log.log(config['runtimes'] + " should be a list of supported runtime names.  " + "Please migrate additional properties to the  runtimes.yml file located in the " + "Cloud Controller and/or Stager.");
		return;
	}

	this.spawns = {};

	this.prod = config['prod'];

	this.local_ip = raft.common.ipAddress();
	// raft.local_ip(config['local_route'])
	this.max_memory = config['max_memory'];
	// in MB
	this.multi_tenant = config['multi_tenant'];
	this.max_clients = this.multi_tenant ? DEFAULT_MAX_CLIENTS : 1;
	this.reserved_mem = 0;
	this.mem_usage = 0;
	this.num_clients = 0;
	this.num_cores = os.cpus().length;
	this.file_viewer_port = config['filer_port'];
	this.filer_start_attempts = 0;
	// How many times we've tried to start the filer
	this.filer_start_timer = 0;
	// The periodic timer responsible for starting the filer
	this.evacuation_delay = config['evacuation_delay'] || DEFAULT_EVACUATION_DELAY;
	this.recovered_droplets = false;

	// Various directories and files we will use
	this.pid_filename = config['pid'];
	this.droplet_dir = config['base_dir'];
	this.staged_dir = path.join(this.droplet_dir, 'staged');
	this.apps_dir = path.join(this.droplet_dir, 'apps');
	this.db_dir = path.join(this.droplet_dir, 'db');
	this.app_state_file = path.join(this.db_dir, APP_STATE_FILE);

	// The DEA will no longer respond to discover/start requests once this usage
	// threshold (in percent) has been exceeded on the filesystem housing the
	// base_dir.
	this.droplet_fs_percent_used_threshold = config['droplet_fs_percent_used_threshold'] || DROPLET_FS_PERCENT_USED_THRESHOLD;
	this.dropet_fs_percent_used = 0;

	//prevent use of shared directory for droplets even if available.
	this.force_http_sharing = config['force_http_sharing'];

	// If a du of the apps dir takes excessively long we log out the directory structure
	// here.
	this.last_apps_dump = null;

	if (config['logging'] && config['logging']['file']) {
		this.apps_dump_dir = path.dirname(config['logging']['file']);
	} else {
		this.apps_dump_dir = os.tmpDir();
	}

	this.nats_uri = raft.config.get('nats');

	config['intervals'] = config['intervals'] || {};

	this.heartbeat_interval = config['intervals']['heartbeat'] || 10;
	this.advertise_interval = config['intervals']['advertise'] || 5;

	// XXX(mjp) - Ugh, this is needed for VCAP::Component.register(). Find a better solution when time permits.
	this.config = config;
};
//
// Inherit from `events.EventEmitter`.
//
util.inherits(Dea, events.EventEmitter);

Dea.prototype.run = function() {
	var uuid = this.uuid;
	var status_config = this.config['status'] || {};
	var self = this;

	this.log.log("Starting VCAP DEA (" + VERSION + ")");

	this.log.log("Using network: " + this.local_ip);

	var mem = this.max_memory + "M";

	if (this.max_memory > 1024) {
		mem = (this.max_memory / 1024.0) + "G";
	}

	this.log.log("Max Memory set to " + mem);
	this.log.log("Utilizing " + this.num_cores + " cpu cores");
	this.multi_tenant ? this.log.log('Allowing multi-tenancy') : this.log.log('Restricting to single tenant');

	this.log.log("Using directory: " + this.droplet_dir);

	function finish() {
		// Recover existing application state.
		self.recover_existing_droplets();
		self.delete_untracked_instance_dirs();

		self.heartbeat_interval = setInterval(self.send_heartbeat.bind(self), self.heartbeat_interval * 1000);
		self.advertise_interval = setInterval(self.send_advertise.bind(self), self.advertise_interval * 1000);

		raft.nats.publish('dea.start', self.hello_message);
	};

	function subscribe() {
		//Setup our listeners..

		raft.nats.subscribe('dea.status', function(msg, reply) {
			self.process_dea_status(msg, reply);
		});
		raft.nats.subscribe('dea.' + uuid + '.status', function(msg, reply) {
			self.process_dea_status(msg, reply);
		});
		raft.nats.subscribe('droplet.status', function(msg, reply) {
			self.process_droplet_status(msg, reply);
		});
		raft.nats.subscribe('dea.discover', function(msg, reply) {
			self.process_dea_discover(msg, reply);
		});
		raft.nats.subscribe('dea.' + uuid + '.discover', function(msg, reply) {
			self.process_dea_discover(msg, reply);
		});
		raft.nats.subscribe('dea.find.droplet', function(msg, reply) {
			self.process_dea_find_droplet(msg, reply);
		});
		raft.nats.subscribe('dea.update', function(msg, reply) {
			self.process_dea_update(msg, reply);
		});
		raft.nats.subscribe('dea.stop', function(msg, reply) {
			self.process_dea_stop(msg, reply);
		});
		raft.nats.subscribe('dea.' + uuid + '.start', function(msg, reply) {
			self.process_dea_start(msg, reply);
		});
		raft.nats.subscribe('router.start', function(msg, reply) {
			self.process_router_start(msg, reply);
		});
		raft.nats.subscribe('dea.locate', function(msg, reply) {
			self.process_dea_locate(msg, reply);
		});
		finish();
	};

	// Make sure all the correct directories exist.
	raft.common.mkdir({
		droplet_dir : this.droplet_dir,
		staged_dir : this.staged_dir,
		apps_dir : this.apps_dir,
		db_dir : this.db_dir
	}, function(err) {
		if (err) {
			self.log.log("Can't create support directories: " + e + "");
			process.exit(1);
			return;
		}
		process.removeAllListeners('SIGINT');
		process.on('SIGINT', function() {
			console.log('Got SIGINT.  Press Control-D to exit.');
			self.shutdown();
		});
		// Calculate how much disk is available before we respond to any messages

		self.log.log("DEA uuid " + uuid);

		// Setup our identity
		self.hello_message = {
			type : 'DEA',
			index : self.config['index'],
			config : self.config,
			id : uuid,
			ip : self.local_ip,
			port : self.file_viewer_port,
			version : VERSION
		};
		subscribe();
	});
};
/**
 *
 *
 *
 */
Dea.prototype.send_heartbeat = function() {
	var self = this;
	if (this.droplets.length || this.shutting_down) {
		return;
	}
	var heartbeat = {
		droplets : [],
		dea : this.uuid,
		prod : this.prod
	};

	Object.keys(this.droplets).forEach(function(key) {
		self.droplets[key].forEach(function(instance) {
			heartbeat['droplets'].push(self.generate_heartbeat(instance));
		});
	});
	raft.nats.publish('dea.heartbeat', heartbeat);
};
/**
 *
 *
 *
 */
Dea.prototype.process_dea_locate = function(msg, reply) {
	this.send_advertise(msg, reply);
};
/**
 *
 *
 *
 */
Dea.prototype.space_available = function() {
	return this.num_clients < this.max_clients && this.reserved_mem < this.max_memory;
};
/**
 *
 *
 *
 */
Dea.prototype.send_advertise = function(msg, reply) {
	var self = this;
	if (!this.space_available() || this.shutting_down) {
		return;
	}
	var advertise_message = {
		id : this.uuid,
		available_memory : this.max_memory - this.reserved_mem,
		runtimes : this.runtime_names,
		prod : this.prod
	};
	if (reply) {
		raft.nats.publish(reply, advertise_message);
	} else {
		raft.nats.publish('dea.advertise', advertise_message);
	}
};
/**
 *
 *
 *
 */
Dea.prototype.send_single_heartbeat = function(instance) {
	var self = this;
	var heartbeat = {
		droplets : [this.generate_heartbeat(instance)],
		dea : this.uuid,
		prod : this.prod
	};
	raft.nats.publish('dea.heartbeat', heartbeat);
};
/**
 *
 *
 *
 */
Dea.prototype.generate_heartbeat = function(instance) {
	var self = this;
	return {
		droplet : instance['droplet_id'],
		version : instance['version'],
		instance : instance['instance_id'],
		index : instance['instance_index'],
		state : instance['state'],
		state_timestamp : instance['state_timestamp'],
		cc_partition : instance['cc_partition']
	};
};
/**
 *
 *
 *
 */
Dea.prototype.process_droplet_status = function(message, reply) {
	var self = this;
	if (this.shutting_down) {
		return
	}
	Object.keys(this.droplets).forEach(function(key) {
		Object.keys(self.droplets[key]).forEach(function(uid) {
			var instance = self.droplets[key][uid];
			if (instance['state'] == 'STARTING' || instance['state'] == 'RUNNING') {
				var response = {
					name : instance['name'],
					host : this.local_ip,
					port : instance['port'],
					uris : instance['uris'],
					uptime : Date.now() - instance['start'],
					mem_quota : instance['mem_quota'],
					disk_quota : instance['disk_quota'],
					fds_quota : instance['fds_quota']
				};

				response['usage'] = self.spawns[instance.instance_id].format().stats;
				raft.nats.publish(reply, response);
			}
		});
	});
};
/**
 *
 *
 *
 */
Dea.prototype.snapshot_varz = function() {
	var self = this;
};
/**
 *
 *
 *
 */
Dea.prototype.process_dea_status = function(msg, reply) {
	var self = this;
	self.log.log("DEA received status message");

	// Respond with our status information here, start with hello string.
	var response = {};
	response['max_memory'] = this.max_memory;
	response['max_memory'] = this.max_memory;
	response['reserved_memory'] = this.reserved_mem;
	response['used_memory'] = this.mem_usage / 1024.0;
	// based in K, translate to MB
	response['num_clients'] = this.num_clients;
	response['state'] = this.shutting_down ? 'SHUTTING_DOWN' : null;
	response['hello'] = this.hello_message;

	// We should send some data here to help describe ourselves.
	raft.nats.publish(reply, response);
};
/**
 *
 *
 *
 */
Dea.prototype.process_dea_discover = function(message, reply) {
	var self = this;
	if (this.shutting_down) {
		self.log.log('Ignoring request, shutting down.');
		return;
	}
	self.log.log("DEA received discovery message");

	if (message.environment && this.environment !== message.environment) {
		self.log.log('Ignoring request, wrong environment [' + message.environment + '].');
		return;
	}

	if (this.num_clients >= this.max_clients || this.reserved_mem > this.max_memory) {
		self.log.log('Ignoring request, not enough resources.');
	} else {
		if (!this.runtime_supported(message['runtime_info'])) {
			self.log.log("Ignoring request, //{" + message['runtime_info'] + "} runtime not supported.");
			return
		}
		if (this.prod && !message_json['prod']) {
			self.log.log("Ignoring request, app_prod=//{" + message['prod'] + "} isn't set, and dea_prod=//{" + this.prod + "} is.");
			return
		}

		var limits = message['limits'];
		var mem_needed = limits['mem'];
		var droplet_id = message['droplet'];

		if (this.reserved_mem + mem_needed > this.max_memory) {
			self.log.log('Ignoring request, not enough resources.');
			return;
		}

		raft.nats.publish(reply, self.hello_message);

	}

};
/**
 *
 *
 *
 */
Dea.prototype.calculate_help_taint = function(droplet_id) {
	var self = this;
	var taint_ms = 0;
	var already_running = this.droplets[droplet_id];
	if (already_running) {

		taint_ms += (already_running.size * TAINT_MS_PER_APP);
	}
	var mem_percent = this.reserved_mem / this.max_memory;
	taint_ms += (mem_percent * TAINT_MS_FOR_MEM);
	// TODO, add in CPU as a component..
	return taint_ms;
};
/**
 *
 *
 *
 */
Dea.prototype.process_dea_find_droplet = function(message, reply) {
	var self = this;
	if (this.shutting_down) {
		return;
	}
	self.log.log("DEA received find droplet message from: " + reply);

	var droplet_id = message['droplet'];
	var version = message['version'];
	var instance_ids = message['instances'] ? message['instances'] : [];
	var indices = message['indices'] ? message['indices'] : null;
	var states = message['states'] ? message['states'] : null;
	var include_stats = message['include_stats'] ? message['include_stats'] : false;

	droplet = this.droplets[droplet_id];
	if (droplet) {
		var instances = [];
		Object.keys(droplet).forEach(function(instanceKey) {
			var instance = droplet[instanceKey];

			var response = {
				dea : self.uuid,
				version : instance['version'],
				droplet : instance['droplet_id'],
				instance : instance['instance_id'],
				index : instance['instance_index'],
				state : instance['state'],
				state_timestamp : instance['state_timestamp'],
				staged : instance['staged'],
				debug_ip : instance['debug_ip'],
				debug_port : instance['debug_port'],
				console_ip : instance['console_ip'],
				console_port : instance['console_port']
			};
			if (include_stats && instance[state] == 'RUNNING') {
				response[stats] = {
					name : instance['name'],
					host : self.local_ip,
					port : instance['port'],
					uris : instance['uris'],
					uptime : Date.now() - instance['start'],
					mem_quota : instance['mem_quota'],
					disk_quota : instance['disk_quota'],
					fds_quota : instance['fds_quota'],
					cores : self.num_cores
				};
			};

			if (self.usage[instance['pid']]) {
				response['stats']['usage'] = self.usage[instance['pid']];

			}
			instances.push(response);
		});

		raft.nats.publish(reply, instances);
	}
};
/**
 *
 *
 *
 */
Dea.prototype.process_dea_update = function(message_json) {
	var self = this;
	if (this.shutting_down) {
		return
	}
	self.log.log("DEA received update message: //{message}");

	var droplet_id = message_json['droplet'];
	droplet = this.droplets[droplet_id];

	if (droplet) {
		var uris = message_json['uris'];
		droplet.forEach(function(instance) {
			current_uris = instance[uris];

			self.log.log("Mapping new URIs.");
			self.log.log("New: //{uris.pretty_inspect} Current: //{current_uris.pretty_inspect}");

			self.register_instance_with_router(instance, {
				uris : (uris - current_uris)
			});
			self.unregister_instance_from_router(instance, {
				uris : (current_uris - uris)
			});

			instance['uris'] = uris;
		});
	}
};
/**
 *
 *
 *
 */
Dea.prototype.process_dea_stop = function(message_json, reply) {
	var self = this;
	if (this.shutting_down) {
		return;
	}

	var droplet_id = message_json['droplet_id'];
	var instance_id = message_json['instance_id'];
	self.log.log("DEA received stop message: " + droplet_id + ':' + instance_id);

	if ( droplet = this.droplets[droplet_id]) {

		var keys = Object.keys(this.droplets);
		keys.forEach(function(key) {
			var instances = self.droplets[key];
			var instancekeys = Object.keys(instances);
			instancekeys.forEach(function(instancekey) {
				var instance = instances[instancekey];
				if (instance_id == instancekey) {
					if (instance['state'] == 'STARTING' || instance['state'] == 'RUNNING') {
						instance['exit_reason'] = 'STOPPED';
					}
					if (instance['state'] == 'CRASHED') {

						instance['state'] = 'DELETED';
						instance['stop_processed'] = false;
					}
					self.stop_droplet(instance);
					raft.nats.publish(reply, instance);
				}
			});
		});
	}

};
/**
 *
 *
 *
 */
Dea.prototype.process_dea_start = function(message, reply) {
	var self = this;
	if (this.shutting_down) {
		return
	}

	var instance_id = raft.common.uuid(true);

	var private_instance_id = raft.common.uuid(true);

	var droplet_id = message['droplet'];
	var instance_index = message['index'] ? message['index'] : this.droplets[droplet_id] ? this.droplets[droplet_id].length : 0;
	var services = message['services'];
	var version = message['version'];
	var name = message['name'];
	var uris = message['uris'];
	var repository = message['repository'];
	var env = message['env'];
	var sha1 = message['sha1'];
	var app_env = message['env'];
	var users = message['users'];
	var runtime = message['runtime_info'];
	var framework = message['framework'];
	var debug = message['debug'];
	var _console = message['console'];
	var flapping = message['flapping'];
	var cc_partition = message['cc_partition'];
	var log_session = message['log_session'];
	var isHttp = message['http'];
	var process_type = message['process_type'];

	var mem = DEFAULT_APP_MEM;
	var num_fds = DEFAULT_APP_NUM_FDS;
	var disk = DEFAULT_APP_DISK;

	if ( limits = message['limits']) {
		if (limits['mem']) {
			mem = limits['mem'];
		}
		if (limits['fds']) {
			num_fds = limits['fds'];
		}
		if (limits['disk']) {
			disk = limits['disk'];
		}

	}
	self.log.log("Requested Limits: mem=" + mem + "M, fds=" + 'mem' + ", disk=" + disk + "M");

	if (this.shutting_down) {
		self.log.log('Shutting down, ignoring start request');
		return;
	} else if (this.reserved_mem + mem > this.max_memory || this.num_clients >= this.max_clients) {
		self.log.log('Do not have room for this client application');
		return;
	}

	var type = typeof message.repository.type === 'string' ? message.repository.type.toLowerCase() : '';

	if (!sha1 || type === '' || !repos[type]) {
		self.log.log("Start request missing proper download information, ignoring request. (//{message})");
		return;
	}
	if (!this.runtime_supported(runtime)) {
		return;
	}

	var tgz_file = path.join(this.staged_dir, sha1 + ".tgz");
	var instance_dir = path.join(this.apps_dir, "" + name + "-" + instance_index + "-" + instance_id + "");

	var instance = {
		droplet_id : droplet_id,
		instance_id : instance_id,
		private_instance_id : private_instance_id,
		instance_index : instance_index,
		name : name,
		sha1 : sha1,
		repository : repository,
		tgz_file : tgz_file,
		dir : instance_dir,
		staged_dir : this.staged_dir,
		apps_dir : this.apps_dir,
		apps_dir : this.db_dir,
		uris : uris,
		env : env,
		users : users,
		version : version,
		mem_quota : mem * (1024 * 1024),
		disk_quota : disk * (1024 * 1024),
		fds_quota : num_fds,
		state : 'STARTING',
		runtime : runtime['name'],
		framework : framework,
		start : Date.now(),
		state_timestamp : Date.now(),
		log_id : "(name=" + name + " app_id=" + droplet_id + " instance=" + instance_id + " index=" + instance_index + ")",
		flapping : flapping ? true : false,
		cc_partition : cc_partition,
		log_session : log_session,
		process_type : process_type
	};

	var instances = this.droplets[droplet_id] || {};
	instances[instance_id] = instance;
	this.droplets[droplet_id] = instances;

	if (instance['uris'].length > 0) {
		this.grab_port(function(err, port) {
			if (err) {
				sefl.crash_message(instance, err);
				self.stop_droplet(instance);
				raft.nats.publish(reply, instance);
				return;
			}

			instance.port = port;

			if (debug) {
				this.grab_port(function(err, port) {
					if (err) {
						sefl.crash_message(instance, err);
						self.stop_droplet(instance);
						raft.nats.publish(reply, instance);
						return;
					}

					instance['debug_ip'] = self.local_ip;
					instance['debug_port'] = debug_port;
					instance['debug_mode'] = true;
					start_operation();
				});
			} else {
				start_operation();
			}
		});
	} else {
		if (debug) {
			this.grab_port(function(err, port) {
				if (err) {
					sefl.crash_message(instance, err);
					self.stop_droplet(instance);
					raft.nats.publish(reply, instance);
					return;
				}

				instance['debug_ip'] = self.local_ip;
				instance['debug_port'] = debug_port;
				instance['debug_mode'] = true;
				start_operation();
			});
		} else {
			start_operation();
		}

	}
	var start_operation = function() {

		self.setup_instance_env(instance);

		self.log.log("Starting up instance: " + droplet_id);
		self.log.log("Clients: " + self.num_clients);
		self.log.log("Reserved Memory Usage: " + self.reserved_mem + " MB of " + self.max_memory + " MB TOTAL");

		self.add_instance_resources(instance);

		var spawn = self.spawns[instance.instance_id] = new Spawn(instance, self.logs.logger);

		spawn.on('error', function(err) {
			self.crash_message(instance, err);
			self.stop_droplet(instance);
			raft.nats.publish(reply, instance);
		});
		spawn.on('stats', function(stats) {
			instance.stats = stats;
		});
		spawn.on('start', function(info) {

			self.detect_port_ready(instance, function(err) {
				if (err) {
					self.crash_message(instance, err);
					self.stop_droplet(instance);
					raft.nats.publish(reply, instance);
					return;
				}
				spawn.responded = true;
				self.log.log("Instance " + instance['log_id'] + " is ready for connections, notifying system of status");
				instance['state'] = 'RUNNING';
				instance['state_timestamp'] = Date.now();

				self.send_single_heartbeat(instance);
				self.register_instance_with_router(instance);
				self.schedule_snapshot();
				raft.nats.publish(reply, instance);
			});
		});
		spawn.build(function(err) {
			if (err) {
				self.crash_message(instance, err);
				self.stop_droplet(instance);
				raft.nats.publish(reply, instance);
				return;
			}
			spawn.spawn(function(err) {
				if (err) {
					self.crash_message(instance, err);
					self.stop_droplet(instance);
					raft.nats.publish(reply, instance);
					return;
				}
			});
		});

	};
};
/**
 *
 *
 *
 */
Dea.prototype.recover_existing_droplets = function() {
	var self = this;

	if (fs.existsSync(this.app_state_file)) {
		this.recovered_droplets = true;
		return;
	}

	try {
		var recovered = require(this.app_state_file);
	} catch(e) {
		fs.writeFileSync(this.app_state_file, '{}');
	}
	var recovered = require(this.app_state_file);
	// Whip through and reconstruct droplet_ids and instance symbols correctly for droplets, state, etc..

	var keys = Object.keys(recovered);

	keys.forEach(function(key) {
		var instances = this.droplets[key] = recovered[key];
		var instancesKeys = Object.key(instances);

		instancesKeys.forEach(function(instanceKey) {
			var instance = instances[instanceKey];

			instances[instanceKey] = instance;
			instance['orphaned'] = true;
			if (instance['start'])
				instance['start'] = Date(instance['start']);
			instance['resources_tracked'] = false;
			self.add_instance_resources(instance);
			instance['stop_processed'] = false;
		});
	});
	this.recovered_droplets = true;
	if (this.num_clients > 0)
		self.log.log("DEA recovered " + this.num_clients + " applications");

	// Go ahead and do a monitoring pass here to detect app state
	this.monitor_apps(true);
	this.send_heartbeat();
	this.schedule_snapshot();

};
/**
 *
 *
 *
 */
Dea.prototype.delete_untracked_instance_dirs = function() {
	var self = this;

	var tracked_instance_dirs = {};

	var keys = Object.keys(this.droplets);
	keys.forEach(function(key) {
		var instances = self.droplets[key];
		var instancekeys = Object.keys(instances);
		instancekeys.forEach(function(instancekey) {
			tracked_instance_dirs[instances[instancekey].dir];
		});
	});
	var all_instance_dirs = fs.readdirSync(self.apps_dir);

	all_instance_dirs.forEach(function(dir) {
		if (!tracked_instance_dirs[dir]) {
			raft.common.rimraf(self.apps_dir + '/' + dir, function() {
				self.log.log("Removing instance dir '" + dir + "', doesn't correspond to any instance entry.");
			});
		}
	});
};
/**
 *
 *
 *
 */
Dea.prototype.runtime_supported = function() {
	var self = this;
	return true;
};
/**
 *
 *
 *
 */
Dea.prototype.send_heartbeat = function() {

	var self = this;

	var heartbeat = {
		droplets : [],
		dea : this.uuid,
		prod : this.prod
	};
	var keys = Object.keys(this.droplets);
	keys.forEach(function(key) {
		var instances = self.droplets[key];
		var instancekeys = Object.keys(instances);
		instancekeys.forEach(function(instancekey) {
			var instance = instances[instancekey];
			heartbeat.droplets.push(self.generate_heartbeat(instance));
		});
	});

	raft.nats.publish('dea.heartbeat', heartbeat);
};
/**
 *
 *
 *
 */
Dea.prototype.register_instance_with_router = function(instance) {
	var self = this;
	raft.nats.publish('router.register', {
		dea : this.uuid,
		host : this.local_ip,
		port : this.spawns[instance['instance_id']].format().port,
		log_session : instance.log_session,
		name : instance.name,
		uris : instance['uris'],
		private_instance_id : instance['private_instance_id']
	});
};
/**
 *
 *
 *
 */
Dea.prototype.schedule_snapshot = function() {
	var self = this;
	if (this.snapshot_scheduled)
		return;
	this.snapshot_scheduled = true;
	process.nextTick(function() {
		self.snapshot_app_state();
	});
};
/**
 *
 *
 *
 */
Dea.prototype.snapshot_app_state = function() {
	var self = this;
	var start = Date.now();
	fs.writeFile(this.db_dir + "/snap_" + start, JSON.stringify(this.droplets), function(err) {
		if (err)
			throw err;
		fs.rename(self.db_dir + "/snap_" + start, self.app_state_file, function() {
			self.log.log("Took " + (Date.now() - start) + " to snapshot application state.");
			self.snapshot_scheduled = false;

		});
	});

};
/**
 *
 *
 *
 */
Dea.prototype.add_instance_resources = function(instance) {
	var self = this;
	if (instance['resources_tracked'])
		return;
	instance['resources_tracked'] = true;
	this.reserved_mem += this.instance_mem_usage_in_mb(instance);
	this.num_clients += 1;
	this.send_advertise();
};
/**
 *
 *
 *
 */
Dea.prototype.instance_mem_usage_in_mb = function(instance) {
	var self = this;
	return (instance['mem_quota'] / (1024 * 1024));
};
/**
 *
 *
 *
 */
Dea.prototype.stop_droplet = function(instance) {
	var self = this;
	// On stop from cloud controller, this can get called twice. Just make sure we are re-entrant..
	if (instance['stop_processed'])
		return;

	// Unplug us from the system immediately, both the routers and health managers.
	//this.send_exited_message(instance);

	this.log.log("Stopping instance " + instance['log_id']);

	// if system thinks this process is running, make sure to execute stop script
	if ([instance['state'] == 'STARTING' || instance['state'] == 'RUNNING']) {
		if (instance['state'] != 'CRASHED')
			instance['state'] = 'STOPPED';
		instance['state_timestamp'] = Date.now();

		// Mark that we have processed the stop command.
		instance['stop_processed'] = true;
		self.spawns[instance.instance_id].on('build.exit', function() {

			// Cleanup resource usage and files..
			self.cleanup_droplet(instance);
		});
		self.spawns[instance.instance_id].stop();
	}
	// Unplug us from the system immediately, both the routers and health managers.
	this.send_exited_message(instance);
};
/**
 *
 *
 *
 */
Dea.prototype.cleanup_droplet = function(instance) {
	var self = this;
	delete this.droplets[instance.droplet_id][instance.instance_id];
	delete self.spawns[instance.instance_id];
	this.remove_instance_resources(instance);
};
/**
 *
 *
 *
 */
Dea.prototype.remove_instance_resources = function(instance) {
	var self = this;
	if (!instance['resources_tracked'])
		return;
	instance['resources_tracked'] = false;
	this.reserved_mem -= this.instance_mem_usage_in_mb(instance);
	this.num_clients -= 1;
	this.send_advertise();
};
/**
 *
 *
 *
 */
Dea.prototype.shutdown = function() {
	var self = this;

	this.log.log("DEA shutting down please wait...");

	this.shutting_down = true;
	var keys = Object.keys(this.droplets);
	keys.forEach(function(key) {
		var instances = self.droplets[key];
		var instancekeys = Object.keys(instances);
		instancekeys.forEach(function(instancekey) {
			var instance = instances[instancekey];
			if (instance['state'] != 'CRASHED')
				instance['exit_reason'] = 'DEA_SHUTDOWN';
			self.stop_droplet(instance);
		});
	});
	raft.nats.publish('dea.exited', self.hello_message);
	setTimeout(function() {
		self.log.log("Bye!");
		process.exit();
	}, 500);
};
/**
 *
 *
 *
 */
Dea.prototype.send_exited_message = function(instance) {
	var self = this;
	if (instance['notified'])
		return;

	this.unregister_instance_from_router(instance);

	if (!instance['exit_reason']) {
		instance['exit_reason'] = 'CRASHED';
		instance['state'] = 'CRASHED';
		instance['state_timestamp'] = Date.now();
	}

	this.send_exited_notification(instance);

	instance['notified'] = true;
};
/**
 *
 *
 *
 */
Dea.prototype.send_exited_notification = function(instance) {
	var self = this;
	if (instance['evacuated'])
		return;
	var exit_message = {
		droplet : instance['droplet_id'],
		version : instance['version'],
		instance : instance['instance_id'],
		index : instance['instance_index'],
		reason : instance['exit_reason'],
		state : instance['state'],
		cc_partition : instance['cc_partition']
	};
	if (instance['state'] == 'CRASHED')
		exit_message['crash_timestamp'] = instance['state_timestamp'];

	raft.nats.publish('droplet.exited', exit_message);
	this.log.log("Sent droplet.exited " + instance['exit_reason']);
};
/**
 *
 *
 *
 */
Dea.prototype.unregister_instance_from_router = function(instance) {
	var self = this;
	raft.nats.publish('router.unregister', {
		dea : this.uuid,
		host : this.local_ip,
		port : instance.port,
		uris : instance['uris'],
		tags : {
			framework : instance['framework'],
			runtime : instance['runtime']
		},
		private_instance_id : instance['private_instance_id']
	});
};
/**
 *
 *
 *
 */
Dea.prototype.process_router_start = function(message) {
	var self = this;
	if (this.shutting_down)
		return;
	this.log.log("DEA received router start message: #{message}");
	var keys = Object.keys(this.droplets);
	keys.forEach(function(key) {
		var instances = self.droplets[key];
		var instancekeys = Object.keys(instances);
		instancekeys.forEach(function(instancekey) {
			var instance = instances[instancekey];
			if (instance['state'] == 'RUNNING')
				self.register_instance_with_router(instance);
		});
	});
};
/**
 *
 *
 *
 */
Dea.prototype.loopInstances = function(cb) {
	var self = this;
	var keys = Object.keys(this.droplets);
	keys.forEach(function(key) {
		var instances = self.droplets[key];
		var instancekeys = Object.keys(instances);
		instancekeys.forEach(function(instancekey) {
			var instance = instances[instancekey];
			cb(instance);
		});
	});
};
/**
 *
 *
 *
 */
Dea.prototype.crash_message = function(instance, err) {
	var self = this;
	instance['state'] = 'CRASHED';
	instance['exit_reason'] = err.message;
	instance['stack_error'] = err.stack || '';
	instance['state_timestamp'] = Date.now();
};
/**
 *
 *
 *
 */
Dea.prototype.grab_port = function(cb) {
	var self = this;
	portfinder.getPort(cb);
};
/**
 *
 *
 *chroot /tmp/dea/apps/bawdy-fifth-1-9090a744/bawdy-fifth usr/local/bin/node app.js'
 */
Dea.prototype.setup_instance_env = function(instance) {
	var self = this;
	var env = {
		//HOME : '/',
		APP : this.create_instance_for_env(instance),
		SERVICES : '[]',
		PORT : instance['port'],
		HOST : self.local_ip
	};

	if (instance['debug_port']) {
		env['DEBUG_IP'] = self.local_ip;
		env['DEBUG_PORT'] = instance['debug_port'];
	}

	var spawnEnv = {};
	Object.keys(instance.env).forEach(function(key) {
		env[key] = instance.env[key];
	});
	instance.env = env;
};
/**
 *
 *
 *
 */
Dea.prototype.create_instance_for_env = function(instance) {
	var self = this;
	var whitelist = ['instance_id', 'instance_index', 'name', 'uris', 'users', 'version', 'start', 'runtime', 'state_timestamp', 'port'];
	var env_hash = {};

	whitelist.forEach(function(key) {
		env_hash[key] = instance[key];
	});
	env_hash['limits'] = {
		fds : instance['fds_quota'],
		mem : instance['mem_quota'],
		disk : instance['disk_quota'],
	};
	env_hash['host'] = this.local_ip;
	return JSON.stringify(env_hash);
};
/**
 *
 *
 *
 */
Dea.prototype.detect_port_ready = function(instance, callback) {
	var self = this;
	var port = instance['port'];

	var attempts = 0;
	function attempt(cb) {
		var socket = new Socket();
		socket.on('connect', function() {
			cb();
			socket.end();
		});
		socket.setTimeout(400);
		socket.on('timeout', function() {
			cb(true);

			socket.destroy();
		});
		socket.on('error', function(exception) {

			cb(true);
		});
		socket.connect(port);
	}

	var loop = function(err) {
		attempts += 1;
		if (err) {
			if (attempts > 120 || instance['state'] != 'STARTING') {
				callback(new Error('App not listing on required port'));
			} else {
				setTimeout(function() {
					attempt(loop);
				}, 500);
			}
		} else {
			callback();
		}
	};
	attempt(loop);
};
