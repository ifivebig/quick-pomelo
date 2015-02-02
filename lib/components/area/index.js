'use strict';

var Q = require('q');
var util = require('util');
var assert = require('assert');
var EventEmitter = require('events').EventEmitter;
var logger = require('pomelo-logger').getLogger('area', __filename);
var schema = require('./schema');

/*
 *
 * @params app - pomelo app instance
 * @params doc - mongodb document based on Area.schema
 */
var Area = function(app){
	EventEmitter.call(this);

	this.app = app;
	this.players = {};
	this.playerEventHandlers = {}; //{playerId : {event : handler}}
};

Area.schema = schema;

util.inherits(Area, EventEmitter);

var proto = Area.prototype;

/**
 * Object life cycle:
 *
 * create: new -> init -> serialize
 * update: new -> deserialize -> start -> running -> serialize -> stop
 * remove: running -> stop -> destroy
 */

// Called before creation, init related resources
proto.init = function(opts){
	opts = opts || {};
	this._id = opts._id;

	var self = this;
	return Q.fcall(function(){
		if(typeof(self.onInit) === 'function'){
			return self.onInit(opts);
		}
	}).then(function(){
		logger.debug('area %s inited', self._id);
	});
};

// Called before remove, remove related resources
proto.destroy = function(){
	//ensure no player
	if(Object.keys(this.players).length !== 0){
		throw new Error('Ares is not empty');
	}

	var self = this;
	return Q.fcall(function(){
		if(typeof(self.onDestroy) === 'function'){
			return self.onDestroy();
		}
	}).then(function(){
		logger.debug('area %s destroyed', self._id);
	});
};

// init live resources after each deserialize
proto.start = function(){
	var self = this;
	return Q.fcall(function(){
		return self.startChannel();
	}).then(function(){
		return self.startPlayers();
	}).then(function(){
		for(var playerId in self.players){
			self.registerPlayerEvents(playerId);
		}
	}).then(function(){
		if(typeof(self.onStart) === 'function'){
			return self.onStart();
		}
	}).then(function(){
		logger.debug('area %s started', self._id);
	});
};

// destroy live resources before each serialize
proto.stop = function(){
	var self = this;
	return Q.fcall(function(){
		if(typeof(self.onStop) === 'function'){
			return self.onStop();
		}
	}).then(function(){
		for(var playerId in self.players){
			self.removePlayerEvents(playerId);
		}
	}).then(function(){
		return self.stopPlayers();
	}).then(function(){
		return self.stopChannel();
	}).then(function(){
		logger.debug('area %s stoped', self._id);
	});
};

// serialize to mongo document
proto.serialize = function(doc){
	doc._id = this._id;
	var self = this;
	return Q.fcall(function(){
		return self.savePlayers();
	}).then(function(){
		if(typeof(self.onSerialize) === 'function'){
			return self.onSerialize(doc);
		}
	}).then(function(){
		logger.debug('area %s serialized', self._id);
	});
};

// deserialize from mongo document
proto.deserialize = function(doc){
	this._id = doc._id;
	var self = this;
	return Q.fcall(function(){
		return self.loadPlayers();
	}).then(function(){
		if(typeof(self.onDeserialize) === 'function'){
			return self.onDeserialize(doc);
		}
	}).then(function(){
		logger.debug('area %s deserialized', self._id);
	});
};

/*
 * Sync players assignment from manager
 * Fix data inconsistency
 */
proto.syncAcquiredPlayers = function(){
	logger.debug('start sync acquired players');

	var self = this;
	return this.app.playerManager.getAcquiredPlayerIds(self._id).then(function(playerIds){
		var playerIdMap = {};
		playerIds.forEach(function(playerId){
			playerIdMap[playerId] = true;
		});

		var promises = [];

		playerIds.forEach(function(playerId){
			if(!self.players[playerId]){
				// release player lock if player is acquired but not joined
				promises.push(Q.fcall(function(){
					return self.app.playerManager.releasePlayer(playerId, self._id);
				}).catch(function(e){
					logger.warn(e.stack);
				}));
			}
		});

		Object.keys(self.players).forEach(function(playerId){
			if(!playerIdMap[playerId]){
				// force quit player if palyer is joined but not acquired
				promises.push(Q.fcall(function(){
					return self.quit(playerId, {force : true});
				}).catch(function(e){
					logger.warn(e.stack);
				}));
			}
		});

		return Q.allSettled(promises).then(function(){
			logger.debug('finish sync acquired players');
		});
	});
};

proto.join = function(playerId){
	var self = this;

	var player = null;
	return Q.fcall(function(){
		return self.app.playerManager.acquirePlayer(playerId, self._id);
	}).then(function(){
		return Q.fcall(function(){
			return self.beforeJoin();
		}).then(function(){
			return self.app.playerManager.loadPlayer(playerId, self._id);
		}).then(function(ret){
			player = ret;
			self.players[playerId] = player;
		}).catch(function(e){
			if(self.players.hasOwnProperty(playerId)){
				delete self.players[playerId];
			}
			self.app.playerManager.releasePlayer(playerId, self._id).catch(function(e){
				logger.warn(e.stack);
			});
			throw e;
		}).then(function(){
			self.registerPlayerEvents(playerId);
			return player.start();
		}).then(function(){
			if(typeof(self.onJoin) === 'function'){
				return self.onJoin(playerId);
			}
		}).then(function(){
			logger.debug('player %s joined area %s', playerId, self._id);
		});
	});
};

// @param opts.force
// @param opts.remove
proto.quit = function(playerId, opts){
	var player = this.players[playerId];
	if(!player){
		logger.warn('player %s not in area %s', playerId, this._id);
		return;
	}

	opts = opts || {};

	if(opts.force){
		this.removePlayerEvents(playerId);
		delete this.players[playerId];
		logger.warn('player %s quit area %s by force', playerId, this._id);
		return;
	}

	var self = this;
	return Q.fcall(function(){
		return self.beforeQuit(playerId);
	}).then(function(){
		self.removePlayerEvents(playerId);
		return player.stop();
	}).then(function(){
		if(!opts.remove){
			return self.app.playerManager.savePlayer(player, self._id);
		}
		else{
			return player.destroy();
		}
	}).then(function(){
		return self.app.playerManager.releasePlayer(playerId, self._id);
	}).then(function(){
		delete self.players[playerId];
	}).then(function(){
		if(typeof(self.onQuit) === 'function'){
			return self.onQuit(playerId);
		}
	}).then(function(){
		logger.debug('player %s quit area %s', playerId, self._id);
	});
};

proto.loadPlayers = function(){
	this.players = {};
	var self = this;
	return Q.fcall(function(){
		return self.app.playerManager.loadAcquiredPlayers(self._id);
	}).then(function(players){
		players.map(function(player){
			self.players[player._id] = player;
		});
		logger.debug('area %s loaded players', self._id);
	});
};

proto.savePlayers = function(){
	var self = this;
	return Q.fcall(function(){
		return self.syncAcquiredPlayers();
	}).then(function(){
		return Q.allSettled(Object.keys(self.players).map(function(playerId){
			var player = self.players[playerId];
			return self.app.playerManager.savePlayer(player, self._id)
					.catch(function(e){
						logger.error(e.stack);
					});
		}));
	});
};

proto.startPlayers = function(){
	var self = this;
	return Q.all(Object.keys(this.players).map(function(playerId){
		var player = self.players[playerId];
		return Q.fcall(function(){
			return player.start();
		});
	}));
};

proto.stopPlayers = function(){
	var self = this;
	return Q.all(Object.keys(this.players).map(function(playerId){
		var player = self.players[playerId];
		return Q.fcall(function(){
			return player.stop();
		});
	}));
};

proto.registerPlayerEvents = function(playerId){
	var self = this;
	this.registerPlayerEvent(playerId, 'connect', function(connectorId){
		self.channel.add(playerId, connectorId);
	});
	this.registerPlayerEvent(playerId, 'disconnect', function(){
		var uidsid = self.channel.getMember(playerId);
		self.channel.leave(uidsid.uid, uidsid.sid);
	});
	this.registerPlayerEvent(playerId, 'notify', function(route, msg){
		self.notify(playerId, route, msg);
	});
};

proto.removePlayerEvents = function(playerId){
	this.removePlayerEvent(playerId, 'connect');
	this.removePlayerEvent(playerId, 'disconnect');
	this.removePlayerEvent(playerId, 'notify');
};

proto.registerPlayerEvent = function(playerId, event, handler){
	var player = this.getPlayer(playerId);
	if(!this.playerEventHandlers.hasOwnProperty(playerId)){
		this.playerEventHandlers[playerId] = {};
	}
	if(this.playerEventHandlers[playerId].hasOwnProperty(event)){
		logger.warn('player %s event %s already registered', playerId, event);
		return;
	}
	player.on(event, handler);
	this.playerEventHandlers[playerId][event] = handler;
};

proto.removePlayerEvent = function(playerId, event){
	var player = this.getPlayer(playerId);
	if(!this.playerEventHandlers[playerId] || !this.playerEventHandlers[playerId][event]){
		logger.warn('player % event %s not registered', playerId, event);
		return;
	}
	player.removeListener(event, this.playerEventHandlers[playerId][event]);
	delete this.playerEventHandlers[playerId][event];
};

proto.startChannel = function(){
	this.channel = this.app.channelService.getChannel('area:' + this._id, true);
	for(var playerId in this.players){
		var player = this.players[playerId];
		if(player._connector){
			this.channel.add(player._id, player._connector);
		}
	}
};

proto.stopChannel = function(){
	this.app.channelService.destroyChannel('area:' + this._id);
};

proto.notifyAll = function(route, msg){
	this.channel.pushMessage(route, msg);
	logger.debug('notify all players in area %s', this._id);
};

proto.notify = function(playerIds, route, msg){
	if(!playerIds){
		this.notifyAll(route, msg);
		return;
	}

	if(!(playerIds instanceof Array)){
		playerIds = [playerIds];
	}
	var self = this;
	var uidsids = playerIds.map(function(playerId){
		return self.channel.getMember(playerId);
	});
	this.app.channelService.pushMessageByUids(route, msg, uidsids);

	logger.debug('notify player %s in area %s', playerIds.join(','), this._id);
};

proto.beforeJoin = function(playerId){
	//Check prerequistics, you can prevent join by throw an exception
};

proto.beforeQuit = function(playerId){
	//Check prerequistics, you can prevent quit by throw an exception
};

proto.getPlayer = function(playerId){
	if(!this.players.hasOwnProperty(playerId)){
		throw new Error('player ' + playerId + ' not in area ' + this._id);
	}
	return this.players[playerId];
};

proto.hasPlayer = function(playerId){
	return !!this.players[playerId];
};

module.exports = Area;