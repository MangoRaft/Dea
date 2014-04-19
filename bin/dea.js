#!/usr/bin/env node

var Agent = require('../')
var raft = require('raft');
var path = require('path');

raft.start()

var agent = new Agent()

agent.run();

raft.common.logo(function(err, logo){
	if(err){
		throw err
	}
	console.log('   * ')
	console.log('   * '+logo.split('\n').join('\n   * '))
	console.log('   * View logger for more infomation.')
})
