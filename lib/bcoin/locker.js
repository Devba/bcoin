/*!
 * locker.js - lock and queue for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

var EventEmitter = require('events').EventEmitter;
var utils = require('./utils');
var assert = utils.assert;

/**
 * Represents a mutex lock for locking asynchronous object methods.
 * @exports Locker
 * @constructor
 * @param {Function} parent - Parent constructor.
 * @param {Function?} add - `add` method (whichever method is queuing data).
 */

function Locker(parent, add) {
  if (!(this instanceof Locker))
    return new Locker(parent, add);

  EventEmitter.call(this);

  this.parent = parent;
  this.jobs = [];
  this.busy = false;

  this.pending = [];
  this.pendingMap = {};
  this.add = add;
}

utils.inherits(Locker, EventEmitter);

/**
 * Test whether the locker has a pending
 * object by key (usually a {@link Hash}).
 * @param {Hash|String} key
 * @returns {Boolean}
 */

Locker.prototype.hasPending = function hasPending(key) {
  return this.pendingMap[key] === true;
};

/**
 * Lock the parent object and all its methods
 * which use the locker. Begin to queue calls.
 * @param {Function} func - The method being called.
 * @param {Array} args - Arguments passed to the method.
 * @param {Boolean?} force - Force a call.
 * @returns {Function} Unlocker - must be
 * called once the method finishes executing in order
 * to resolve the queue.
 */

Locker.prototype.lock = function lock(func, args, force) {
  var self = this;
  var obj, called;

  if (force) {
    assert(this.busy);
    return function unlock() {
      assert(!called);
      called = true;
    };
  }

  if (this.busy) {
    if (this.add && func === this.add) {
      obj = args[0];
      this.pending.push(obj);
      this.pendingMap[obj.hash('hex')] = true;
    }
    this.jobs.push([func, args]);
    return;
  }

  this.busy = true;

  return function unlock() {
    var item, obj;

    assert(!called);
    called = true;

    self.busy = false;

    if (self.add && func === self.add) {
      if (self.pending.length === 0)
        self.emit('drain');
    }

    if (self.jobs.length === 0)
      return;

    item = self.jobs.shift();

    if (self.add && item[0] === self.add) {
      obj = item[1][0];
      assert(obj === self.pending.shift());
      delete self.pendingMap[obj.hash('hex')];
    }

    item[0].apply(self.parent, item[1]);
  };
};

/**
 * Destroy the locker. Purge all pending calls.
 */

Locker.prototype.destroy = function destroy() {
  this.pending.length = 0;
  this.pendingMap = {};
  this.jobs.length = 0;
};

/**
 * Wait for a drain (empty queue).
 * @param {Function} callback
 */

Locker.prototype.onDrain = function onDrain(callback) {
  if (this.pending.length === 0)
    return callback();

  this.once('drain', callback);
};

/*
 * Expose
 */

module.exports = Locker;
