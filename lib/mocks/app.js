'use strict';

var util = require('util');
var path = require('path');
var P = require('memdb').Promise;
var logger = require('memdb').logger.getLogger('test', __filename);

/*
 * @param opts.serverId
 * @param opts.components - {'name' : opts}
 * @param opts.rpc
 */
var App = function(opts){
    opts = opts || {};
    this.serverId = opts.serverId;
    this.serverType = opts.serverType;

    this.settings = {};
    this.components = {};
    this._routes = {};

    this._base = path.join(__dirname, '../..');
};

var proto = App.prototype;

proto.start = function(cb){
    P.bind(this)
    .then(function(){
        return P.promisify(this.optComponents, this)('start');
    })
    .then(function(){
        return P.promisify(this.optComponents, this)('afterStart');
    })
    .nodeify(cb);
};

proto.stop = function(force, cb){
    P.bind(this)
    .then(function(){
        return P.promisify(this.optComponents, this)('beforeStop');
    })
    .then(function(){
        return P.promisify(this.stopComponents, this)(force);
    })
    .nodeify(cb);
};

proto.load = function(component, opts){
    var instance = component(this, opts);
    this.components[instance.name] = instance;
};

proto.optComponents = function(method, cb){
    P.bind(this)
    .then(function(){
        return Object.keys(this.components);
    })
    .map(function(name){
        var component = this.components[name];
        if(typeof(component[method]) === 'function'){
            return P.promisify(component[method], component)();
        }
    })
    .nodeify(cb);
};

proto.stopComponents = function(force, cb){
    if(typeof(force) === 'function'){
        cb = force;
        force = false;
    }

    P.bind(this)
    .then(function(){
        return Object.keys(this.components);
    })
    .map(function(name){
        var component = this.components[name];
        if(typeof(component.stop) === 'function'){
            return P.promisify(component.stop, component)(force);
        }
    })
    .nodeify(cb);
};

proto.getServerId = function(){
    return this.serverId;
};

proto.getServerType = function(){
    return this.serverType;
};

proto.get = function(name){
    return this.settings[name];
};

proto.set = function(name, value, attach){
    this.settings[name] = value;
    if(attach){
        this[name] = value;
    }
};

proto.getBase = function(){
    return this._base;
};

proto.setBase = function(basePath){
    this._base = basePath;
};

proto.route = function(serverType, fn){
    this._routes[serverType] = fn;
};

proto.rpcInvoke = function(serverId, opts, cb){
    logger.info('rpcInvoke %s %j', serverId, opts);
    cb(null);
};

module.exports = function(opts){
    return new App(opts);
};
