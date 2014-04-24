#!/usr/bin/env node

/*
 *
 * (C) 2014, MangoRaft.
 *
 */

var Agent = require('../');
var raft = require('raft');
var path = require('path');

raft.once('start', function() {
	var agent = new Agent(process.argv[2]);
	agent.run();
});

raft.common.printLogo();

raft.start(process.argv[3]); 