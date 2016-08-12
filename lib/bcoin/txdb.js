/*!
 * txdb.js - persistent transaction pool
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

/*
 * Database Layout:
 *   t/[hash] -> extended tx
 *   c/[hash]/[index] -> coin
 *   s/[hash]/[index] -> spent by hash
 *   o/[hash]/[index] -> orphan inputs
 *   p/[hash] -> dummy (pending flag)
 *   m/[time]/[hash] -> dummy (tx by time)
 *   h/[height]/[hash] -> dummy (tx by height)
 *   T/[id]/[name]/[hash] -> dummy (tx by wallet id)
 *   P/[id]/[name]/[hash] -> dummy (pending tx by wallet/account id)
 *   M/[id]/[name]/[time]/[hash] -> dummy (tx by time + id/account)
 *   H/[id]/[name]/[height]/[hash] -> dummy (tx by height + id/account)
 *   C/[id]/[name]/[hash]/[index] -> dummy (coin by id/account)
 */

var bcoin = require('./env');
var utils = require('./utils');
var assert = bcoin.utils.assert;
var DUMMY = new Buffer([0]);
var pad32 = utils.pad32;
var BufferReader = require('./reader');
var BufferWriter = require('./writer');

/**
 * TXDB
 * @exports TXDB
 * @constructor
 * @param {WalletDB} db
 * @param {WalletID} id
 */

function TXDB(db, id) {
  if (!(this instanceof TXDB))
    return new TXDB(db, id);

  this.id = id || null;
  this.walletdb = db;
  this.db = db.db;
  this.logger = db.logger;
  this.network = db.network;
  this.options = db.options;
  this.busy = false;
  this.jobs = [];
  this.locker = new bcoin.locker(this);
  this.current = null;
  this.coinCache = new bcoin.lru(10000, 1);
}

/**
 * Compile wallet prefix.
 * @param {String} key
 */

TXDB.prototype.prefix = function prefix(key) {
  assert(this.id);
  return 't/' + this.id + '/' + key;
};

/**
 * Emit transaction event.
 * @private
 * @param {String} event
 * @param {TX} tx
 * @param {PathInfo} info
 */

TXDB.prototype.emit = function emit(event, tx, info) {
  return this.walletdb.emitTX(event, tx, info);
};

/**
 * Invoke the mutex lock.
 * @private
 * @returns {Function} unlock
 */

TXDB.prototype._lock = function _lock(func, args, force) {
  return this.locker.lock(func, args, force);
};

/**
 * Start a batch.
 * @returns {Batch}
 */

TXDB.prototype.start = function start() {
  assert(!this.current);
  this.current = this.db.batch();
  return this.current;
};

/**
 * Put key and value to current batch.
 * @param {String} key
 * @param {Buffer} value
 */

TXDB.prototype.put = function put(key, value) {
  assert(this.current);
  this.current.put(this.prefix(key), value);
};

/**
 * Delete key from current batch.
 * @param {String} key
 */

TXDB.prototype.del = function del(key) {
  assert(this.current);
  this.current.del(this.prefix(key));
};

/**
 * Get current batch.
 * @returns {Batch}
 */

TXDB.prototype.batch = function batch() {
  assert(this.current);
  return this.current;
};

/**
 * Drop current batch.
 * @returns {Batch}
 */

TXDB.prototype.drop = function drop() {
  assert(this.current);
  this.current.clear();
  this.current = null;
};

/**
 * Fetch.
 * @param {String} key
 */

TXDB.prototype.fetch = function fetch(key, parse, callback) {
  this.db.fetch(this.prefix(key), parse, callback);
};

/**
 * Get.
 * @param {String} key
 */

TXDB.prototype.get = function get(key, callback) {
  this.db.get(this.prefix(key), callback);
};

/**
 * Has.
 * @param {String} key
 */

TXDB.prototype.has = function has(key, callback) {
  this.db.has(this.prefix(key), callback);
};

/**
 * Iterate.
 * @param {Object} options
 * @param {Function} callback
 */

TXDB.prototype.iterate = function iterate(options, callback) {
  if (options.gte)
    options.gte = this.prefix(options.gte);
  if (options.lte)
    options.lte = this.prefix(options.lte);
  this.db.iterate(options, callback);
};

/**
 * Commit current batch.
 * @param {Function} callback
 */

TXDB.prototype.commit = function commit(callback) {
  var self = this;
  assert(this.current);
  this.current.write(function(err) {
    if (err) {
      self.current = null;
      return callback(err);
    }
    self.current = null;
    return callback();
  });
};

/**
 * Map a transactions' addresses to wallet IDs.
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, {@link PathInfo}].
 */

TXDB.prototype.getInfo = function getInfo(tx, callback) {
  this.walletdb.getPathInfo(this.id, tx, callback);
};

/**
 * Add an orphan (tx hash + input index)
 * to orphan list. Stored by its required coin ID.
 * @private
 * @param {String} key - Required coin hash + index.
 * @param {Hash} hash - Orphan transaction hash.
 * @param {Number} index - Orphan input index.
 * @param {Function} callback - Returns [Error, Buffer].
 */

TXDB.prototype._addOrphan = function _addOrphan(key, outpoint, callback) {
  var self = this;
  var p = new BufferWriter();
  var k = 'o/' + key;

  this.get(k, function(err, data) {
    if (err)
      return callback(err);

    if (data)
      p.writeBytes(data);

    p.writeBytes(outpoint);

    self.put(k, p.render());

    return callback();
  });
};

/**
 * Retrieve orphan list by coin ID.
 * @private
 * @param {String} key
 * @param {Function} callback - Returns [Error, {@link Orphan}].
 */

TXDB.prototype._getOrphans = function _getOrphans(key, callback) {
  var self = this;
  var items = [];

  this.fetch('o/' + key, function(data) {
    var p = new BufferReader(data);
    var orphans = [];

    while (p.left())
      orphans.push(bcoin.outpoint.fromRaw(p));

    return orphans;
  }, function(err, orphans) {
    if (err)
      return callback(err);

    if (!orphans)
      return callback();

    utils.forEachSerial(orphans, function(orphan, next) {
      self.getTX(orphan.hash, function(err, tx) {
        if (err)
          return next(err);

        items.push([orphan, tx]);

        next();
      });
    }, function(err) {
      if (err)
        return callback(err);

      return callback(null, items);
    });
  });
};

/**
 * Retrieve coins for own inputs, remove
 * double spenders, and verify inputs.
 * @private
 * @param {TX} tx
 * @param {PathInfo} info
 * @param {Function} callback - Returns [Error].
 */

TXDB.prototype._verify = function _verify(tx, info, callback) {
  var self = this;

  utils.forEachSerial(tx.inputs, function(input, next, i) {
    var prevout = input.prevout;
    var address;

    if (tx.isCoinbase())
      return next();

    address = input.getHash('hex');

    // Only bother if this input is ours.
    if (!info.hasPath(address))
      return next();

    self.getCoin(prevout.hash, prevout.index, function(err, coin) {
      if (err)
        return next(err);

      if (coin) {
        // Add TX to inputs and spend money
        input.coin = coin;

        // Skip invalid transactions
        if (self.options.verify) {
          if (!tx.verifyInput(i))
            return callback(null, false);
        }

        return next();
      }

      input.coin = null;

      self.isSpent(prevout.hash, prevout.index, function(err, spent) {
        if (err)
          return next(err);

        // Are we double-spending?
        // Replace older txs with newer ones.
        if (!spent)
          return next();

        self.getTX(prevout.hash, function(err, prev) {
          if (err)
            return next(err);

          if (!prev)
            return callback(new Error('Could not find double-spent coin.'));

          // NOTE: Could use d/spent.hash/spent.index
          // here instead of getting a tx.
          input.coin = bcoin.coin.fromTX(prev, prevout.index);

          // Skip invalid transactions
          if (self.options.verify) {
            if (!tx.verifyInput(i))
              return callback(null, false);
          }

          self._removeConflict(spent.hash, tx, function(err, rtx, rinfo) {
            if (err)
              return next(err);

            // Spender was not removed, the current
            // transaction is not elligible to be added.
            if (!rtx)
              return callback(null, false);

            self.emit('conflict', rtx, rinfo);

            next();
          });
        });
      });
    });
  }, function(err) {
    if (err)
      return callback(err);
    return callback(null, true);
  });
};

/**
 * Attempt to resolve orphans for an output.
 * @private
 * @param {TX} tx
 * @param {Number} index
 * @param {Function} callback
 */

TXDB.prototype._resolveOrphans = function _resolveOrphans(tx, index, callback) {
  var self = this;
  var hash = tx.hash('hex');
  var key = hash + '/' + index;
  var coin;

  this._getOrphans(key, function(err, orphans) {
    if (err)
      return callback(err);

    if (!orphans)
      return callback(null, false);

    self.del('o/' + key);

    coin = bcoin.coin.fromTX(tx, index);

    // Add input to orphan
    utils.forEachSerial(orphans, function(item, next) {
      var input = item[0];
      var orphan = item[1];

      // Probably removed by some other means.
      if (!orphan)
        return next();

      orphan.inputs[input.index].coin = coin;

      assert(orphan.inputs[input.index].prevout.hash === hash);
      assert(orphan.inputs[input.index].prevout.index === index);

      // Verify that input script is correct, if not - add
      // output to unspent and remove orphan from storage
      if (!self.options.verify || orphan.verifyInput(input.index)) {
        self.put('d/' + input.hash + '/' + pad32(input.index), coin.toRaw());
        return callback(null, true);
      }

      self._lazyRemove(orphan, next);
    }, function(err) {
      if (err)
        return callback(err);

      return callback(null, false);
    });
  });
};

/**
 * Add transaction, runs _confirm (separate batch) and
 * verify (separate batch for double spenders).
 * @private
 * @param {TX} tx
 * @param {PathInfo} info
 * @param {Function} callback
 */

TXDB.prototype.add = function add(tx, info, callback) {
  var self = this;
  var unlock = this._lock(add, [tx, info, callback]);
  var hash, i, path, id;

  if (!unlock)
    return;

  callback = utils.wrap(callback, unlock);

  if (tx.mutable)
    tx = tx.toTX();

  // Attempt to confirm tx before adding it.
  this._confirm(tx, info, function(err, existing) {
    if (err)
      return callback(err);

    // Ignore if we already have this tx.
    if (existing)
      return callback(null, true, info);

    self._verify(tx, info, function(err, result) {
      if (err)
        return callback(err);

      if (!result)
        return callback(null, result, info);

      hash = tx.hash('hex');

      self.start();
      self.put('t/' + hash, tx.toExtended());

      if (tx.ts === 0)
        self.put('p/' + hash, DUMMY);
      else
        self.put('h/' + pad32(tx.height) + '/' + hash, DUMMY);

      self.put('m/' + pad32(tx.ps) + '/' + hash, DUMMY);

      for (i = 0; i < info.accounts.length; i++) {
        id = info.accounts[i];
        self.put('T/' + id + '/' + hash, DUMMY);
        if (tx.ts === 0)
          self.put('P/' + id + '/' + hash, DUMMY);
        else
          self.put('H/' + id + '/' + pad32(tx.height) + '/' + hash, DUMMY);
        self.put('M/' + id + '/' + pad32(tx.ps) + '/' + hash, DUMMY);
      }

      // Consume unspent money or add orphans
      utils.forEachSerial(tx.inputs, function(input, next, i) {
        var prevout = input.prevout;
        var key, address, outpoint;

        if (tx.isCoinbase())
          return next();

        address = input.getHash('hex');
        path = info.getPath(address);

        // Only bother if this input is ours.
        if (!path)
          return next();

        key = prevout.hash + '/' + prevout.index;

        // s/[outpoint-key] -> [spender-hash]|[spender-input-index]
        outpoint = bcoin.outpoint.fromTX(tx, i).toRaw();
        self.put('s/' + key, outpoint);

        if (!input.coin) {
          // Add orphan, if no parent transaction is yet known
          return self._addOrphan(key, outpoint, next);
        }

        self.del('C/' + path.account + '/' + key);

        self.del('c/' + key);
        self.put('d/' + hash + '/' + pad32(i), input.coin.toRaw());

        self.coinCache.remove(key);

        next();
      }, function(err) {
        if (err) {
          self.drop();
          return callback(err);
        }

        // Add unspent outputs or resolve orphans
        utils.forEachSerial(tx.outputs, function(output, next, i) {
          var address = output.getHash('hex');
          var key = hash + '/' + i;
          var coin;

          if (output.script.isUnspendable())
            return next();

          path = info.getPath(address);

          // Do not add unspents for outputs that aren't ours.
          if (!path)
            return next();

          self._resolveOrphans(tx, i, function(err, orphans) {
            if (err)
              return next(err);

            if (orphans)
              return next();

            coin = bcoin.coin.fromTX(tx, i);

            self.put('C/' + path.account + '/' + key, DUMMY);

            coin = coin.toRaw();

            self.put('c/' + key, coin);

            self.coinCache.set(key, coin);

            next();
          });
        }, function(err) {
          if (err) {
            self.drop();
            return callback(err);
          }

          self.commit(function(err) {
            if (err)
              return callback(err);

            self.emit('tx', tx, info);

            if (tx.ts !== 0)
              self.emit('confirmed', tx, info);

            return callback(null, true, info);
          });
        });
      });
    });
  });
};

/**
 * Remove spenders that have not been confirmed. We do this in the
 * odd case of stuck transactions or when a coin is double-spent
 * by a newer transaction. All previously-spending transactions
 * of that coin that are _not_ confirmed will be removed from
 * the database.
 * @private
 * @param {Hash} hash
 * @param {TX} ref - Reference tx, the tx that double-spent.
 * @param {Function} callback - Returns [Error, Boolean].
 */

TXDB.prototype._removeConflict = function _removeConflict(hash, ref, callback) {
  var self = this;

  this.getTX(hash, function(err, tx) {
    if (err)
      return callback(err);

    if (!tx)
      return callback(new Error('Could not find spender.'));

    if (tx.ts !== 0) {
      // If spender is confirmed and replacement
      // is not confirmed, do nothing.
      if (ref.ts === 0)
        return callback();

      // If both are confirmed but replacement
      // is older than spender, do nothing.
      if (ref.ts < tx.ts)
        return callback();
    } else {
      // If spender is unconfirmed and replacement
      // is confirmed, do nothing.
      if (ref.ts !== 0)
        return callback();

      // If both are unconfirmed but replacement
      // is older than spender, do nothing.
      if (ref.ps < tx.ps)
        return callback();
    }

    self._removeRecursive(tx, function(err, result, info) {
      if (err)
        return callback(err);
      return callback(null, tx, info);
    });
  });
};

/**
 * Remove a transaction and recursively
 * remove all of its spenders.
 * @private
 * @param {TX} tx - Transaction to be removed.
 * @param {Function} callback - Returns [Error, Boolean].
 */

TXDB.prototype._removeRecursive = function _removeRecursive(tx, callback) {
  var self = this;
  var hash = tx.hash('hex');

  utils.forEachSerial(tx.outputs, function(output, next, i) {
    self.isSpent(hash, i, function(err, spent) {
      if (err)
        return next(err);

      if (!spent)
        return next();

      // Remove all of the spender's spenders first.
      self.getTX(spent.hash, function(err, tx) {
        if (err)
          return next(err);

        if (!tx)
          return next(new Error('Could not find spender.'));

        self._removeRecursive(tx, next);
      });
    });
  }, function(err) {
    if (err)
      return callback(err);

    self.start();

    // Remove the spender.
    self._lazyRemove(tx, function(err, result, info) {
      if (err) {
        self.drop();
        return callback(err);
      }

      self.commit(function(err) {
        if (err)
          return callback(err);
        return callback(null, result, info);
      });
    });
  });
};

/**
 * Test an entire transaction to see
 * if any of its outpoints are a double-spend.
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, Boolean].
 */

TXDB.prototype.isDoubleSpend = function isDoubleSpend(tx, callback) {
  var self = this;

  utils.everySerial(tx.inputs, function(input, next) {
    var prevout = input.prevout;
    self.isSpent(prevout.hash, prevout.index, function(err, spent) {
      if (err)
        return next(err);
      return next(null, !spent);
    });
  }, function(err, result) {
    if (err)
      return callback(err);
    return callback(null, !result);
  });
};

/**
 * Test a whether a coin has been spent.
 * @param {Hash} hash
 * @param {Number} index
 * @param {Function} callback - Returns [Error, Boolean].
 */

TXDB.prototype.isSpent = function isSpent(hash, index, callback) {
  var key = 's/' + hash + '/' + index;
  this.fetch(key, function(data) {
    return bcoin.outpoint.fromRaw(data);
  }, callback);
};

/**
 * Attempt to confirm a transaction.
 * @private
 * @param {TX} tx
 * @param {AddressMap} info
 * @param {Function} callback - Returns [Error, Boolean]. `false` if
 * the transaction should be added to the database, `true` if the
 * transaction was confirmed, or should be ignored.
 */

TXDB.prototype._confirm = function _confirm(tx, info, callback) {
  var self = this;
  var hash = tx.hash('hex');
  var i, id;

  this.getTX(hash, function(err, existing) {
    if (err)
      return callback(err);

    // Haven't seen this tx before, add it.
    if (!existing)
      return callback(null, false, info);

    // Existing tx is already confirmed. Ignore.
    if (existing.ts !== 0)
      return callback(null, true, info);

    // The incoming tx won't confirm the
    // existing one anyway. Ignore.
    if (tx.ts === 0)
      return callback(null, true, info);

    // Tricky - update the tx and coin in storage,
    // and remove pending flag to mark as confirmed.
    assert(tx.height >= 0);

    // Save the original received time.
    tx.ps = existing.ps;

    self.start();

    self.put('t/' + hash, tx.toExtended());

    self.del('p/' + hash);
    self.put('h/' + pad32(tx.height) + '/' + hash, DUMMY);

    for (i = 0; i < info.accounts.length; i++) {
      id = info.accounts[i];
      self.del('P/' + id + '/' + hash);
      self.put('H/' + id + '/' + pad32(tx.height) + '/' + hash, DUMMY);
    }

    utils.forEachSerial(tx.outputs, function(output, next, i) {
      var address = output.getHash('hex');
      var key = hash + '/' + i;

      // Only update coins if this output is ours.
      if (!info.hasPath(address))
        return next();

      self.getCoin(hash, i, function(err, coin) {
        if (err)
          return next(err);

        if (!coin) {
          // TODO: Update spent coin here!
          return next();
        }

        coin.height = tx.height;
        coin = coin.toRaw();

        self.put('c/' + key, coin);

        self.coinCache.set(key, coin);

        next();
      });
    }, function(err) {
      if (err) {
        self.drop();
        return callback(err);
      }

      self.commit(function(err) {
        if (err)
          return callback(err);

        self.emit('tx', tx, info);
        self.emit('confirmed', tx, info);

        return callback(null, true, info);
      });
    });
  });
};

/**
 * Remove a transaction from the database. Disconnect inputs.
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error].
 */

TXDB.prototype.remove = function remove(hash, callback, force) {
  var unlock = this._lock(remove, [hash, callback], force);

  if (!unlock)
    return;

  callback = utils.wrap(callback, unlock);

  this._removeRecursive(hash, function(err, result, info) {
    if (err)
      return callback(err);

    return callback(null, !!result, info);
  });
};

/**
 * Remove a transaction from the database, but do not
 * look up the transaction. Use the passed-in transaction
 * to disconnect.
 * @param {TX} tx
 * @param {Function} callback - Returns [Error].
 */

TXDB.prototype._lazyRemove = function lazyRemove(tx, callback) {
  var self = this;
  this.getInfo(tx, function(err, info) {
    if (err)
      return callback(err);

    if (!info)
      return callback(null, false);

    self._remove(tx, info, callback);
  });
};

/**
 * Remove a transaction from the database. Disconnect inputs.
 * @private
 * @param {TX} tx
 * @param {AddressMap} info
 * @param {Function} callback - Returns [Error].
 */

TXDB.prototype._remove = function remove(tx, info, callback) {
  var self = this;
  var hash = tx.hash('hex');
  var i, path, id, key, address, input, output, coin;

  this.del('t/' + hash);

  if (tx.ts === 0)
    this.del('p/' + hash);
  else
    this.del('h/' + pad32(tx.height) + '/' + hash);

  this.del('m/' + pad32(tx.ps) + '/' + hash);

  for (i = 0; i < info.accounts.length; i++) {
    id = info.accounts[i];
    this.del('T/' + id + '/' + hash);
    if (tx.ts === 0)
      this.del('P/' + id + '/' + hash);
    else
      this.del('H/' + id + '/' + pad32(tx.height) + '/' + hash);
    this.del('M/' + id + '/' + pad32(tx.ps) + '/' + hash);
  }

  this.fillHistory(tx, function(err) {
    if (err)
      return callback(err);

    for (i = 0; i < tx.inputs.length; i++) {
      input = tx.inputs[i];
      key = input.prevout.hash + '/' + input.prevout.index;
      address = input.getHash('hex');

      if (tx.isCoinbase())
        break;

      if (!input.coin)
        continue;

      path = info.getPath(address);

      if (!path)
        continue;

      self.put('C/' + path.account + '/' + key, DUMMY);

      coin = input.coin.toRaw();

      self.put('c/' + key, coin);
      self.del('d/' + hash + '/' + pad32(i));
      self.del('s/' + key);
      self.del('o/' + key);

      self.coinCache.set(key, coin);
    }

    for (i = 0; i < tx.outputs.length; i++) {
      output = tx.outputs[i];
      key = hash + '/' + i;
      address = output.getHash('hex');

      if (output.script.isUnspendable())
        continue;

      path = info.getPath(address);

      if (!path)
        continue;

      self.del('C/' + path.account + '/' + key);

      self.del('c/' + key);

      self.coinCache.remove(key);
    }

    self.emit('remove tx', tx, info);

    return callback(null, true, info);
  });
};

/**
 * Unconfirm a transaction. This is usually necessary after a reorg.
 * @param {Hash} hash
 * @param {Function} callback
 */

TXDB.prototype.unconfirm = function unconfirm(hash, callback, force) {
  var self = this;
  var unlock = this._lock(unconfirm, [hash, callback], force);

  if (!unlock)
    return;

  callback = utils.wrap(callback, unlock);

  this.getTX(hash, function(err, tx) {
    if (err)
      return callback(err);

    if (!tx)
      return callback(null, true);

    self.getInfo(tx, function(err, info) {
      if (err)
        return callback(err);

      if (!info)
        return callback(null, false);

      self.start();

      self._unconfirm(tx, info, function(err, result, info) {
        if (err) {
          self.drop();
          return callback(err);
        }

        self.commit(function(err) {
          if (err)
            return callback(err);
          return callback(null, result, info);
        });
      });
    });
  });
};

/**
 * Unconfirm a transaction. This is usually necessary after a reorg.
 * @param {Hash} hash
 * @param {AddressMap} info
 * @param {Function} callback
 */

TXDB.prototype._unconfirm = function unconfirm(tx, info, callback, force) {
  var self = this;
  var hash = tx.hash('hex');
  var height = tx.height;
  var i, id;

  if (height !== -1)
    return callback(null, false, info);

  tx.height = -1;
  tx.ts = 0;
  tx.index = -1;
  tx.block = null;

  this.put('t/' + hash, tx.toExtended());

  this.put('p/' + hash, DUMMY);
  this.del('h/' + pad32(height) + '/' + hash);

  for (i = 0; i < info.accounts.length; i++) {
    id = info.accounts[i];
    this.put('P/' + id + '/' + hash, DUMMY);
    this.del('H/' + id + '/' + pad32(height) + '/' + hash);
  }

  utils.forEachSerial(tx.outputs, function(output, next, i) {
    var key = hash + '/' + i;
    self.getCoin(hash, i, function(err, coin) {
      if (err)
        return next(err);

      if (!coin) {
        // TODO: Update spent coin here
        return next();
      }

      coin.height = tx.height;
      coin = coin.toRaw();

      self.put('c/' + key, coin);

      self.coinCache.set(key, coin);

      next();
    });
  }, function(err) {
    if (err)
      return callback(err);

    self.emit('unconfirmed', tx, info);

    return callback(null, true, info);
  });
};

/**
 * Get hashes of all transactions in the database.
 * @param {Number?} account
 * @param {Function} callback - Returns [Error, {@link Hash}[]].
 */

TXDB.prototype.getHistoryHashes = function getHistoryHashes(account, callback) {
  if (typeof account === 'function') {
    callback = account;
    account = null;
  }

  this.iterate({
    gte: account ? 'T/' + account + '/' : 't',
    lte: account ? 'T/' + account + '/~' : 't~',
    transform: function(key) {
      key = key.split('/');
      if (account)
        return key[4];
      return key[3];
    }
  }, callback);
};

/**
 * Get hashes of all unconfirmed transactions in the database.
 * @param {Number?} account
 * @param {Function} callback - Returns [Error, {@link Hash}[]].
 */

TXDB.prototype.getUnconfirmedHashes = function getUnconfirmedHashes(account, callback) {
  if (typeof account === 'function') {
    callback = account;
    account = null;
  }

  this.iterate({
    gte: account ? 'P/' + account + '/' : 'p',
    lte: account ? 'P/' + account + '/~' : 'p~',
    transform: function(key) {
      key = key.split('/');
      if (account)
        return key[4];
      return key[3];
    }
  }, callback);
};

/**
 * Get all coin hashes in the database.
 * @param {Number?} account
 * @param {Function} callback - Returns [Error, {@link Hash}[]].
 */

TXDB.prototype.getCoinHashes = function getCoinHashes(account, callback) {
  if (typeof account === 'function') {
    callback = account;
    account = null;
  }

  this.iterate({
    gte: account ? 'C/' + account + '/' : 'c',
    lte: account ? 'C/' + account + '/~' : 'c~',
    transform: function(key) {
      key = key.split('/');
      if (account)
        return [key[4], +key[5]];
      return [key[3], +key[4]];
    }
  }, callback);
};

/**
 * Get TX hashes by height range.
 * @param {Number?} account
 * @param {Object} options
 * @param {Number} options.start - Start height.
 * @param {Number} options.end - End height.
 * @param {Number?} options.limit - Max number of records.
 * @param {Boolean?} options.reverse - Reverse order.
 * @param {Function} callback - Returns [Error, {@link Hash}[]].
 */

TXDB.prototype.getHeightRangeHashes = function getHeightRangeHashes(account, options, callback) {
  if (typeof account !== 'string') {
    callback = options;
    options = account;
    account = null;
  }

  this.iterate({
    gte: account
      ? 'H/' + account + '/' + pad32(options.start) + '/'
      : 'h/' + pad32(options.start) + '/',
    lte: account
      ? 'H/' + account + '/' + pad32(options.end) + '/~'
      : 'h/' + pad32(options.end) + '/~',
    limit: options.limit,
    reverse: options.reverse,
    transform: function(key) {
      key = key.split('/');
      if (account)
        return key[4];
      return key[3];
    }
  }, callback);
};

/**
 * Get TX hashes by height.
 * @param {Number} height
 * @param {Function} callback - Returns [Error, {@link Hash}[]].
 */

TXDB.prototype.getHeightHashes = function getHeightHashes(height, callback) {
  return this.getHeightRangeHashes({ start: height, end: height }, callback);
};

/**
 * Get TX hashes by timestamp range.
 * @param {Number?} account
 * @param {Object} options
 * @param {Number} options.start - Start height.
 * @param {Number} options.end - End height.
 * @param {Number?} options.limit - Max number of records.
 * @param {Boolean?} options.reverse - Reverse order.
 * @param {Function} callback - Returns [Error, {@link Hash}[]].
 */

TXDB.prototype.getRangeHashes = function getRangeHashes(account, options, callback) {
  if (typeof account === 'function') {
    callback = account;
    account = null;
  }

  this.iterate({
    gte: account
      ? 'M/' + account + '/' + pad32(options.start) + '/'
      : 'm/' + pad32(options.start) + '/',
    lte: account
      ? 'M/' + account + '/' + pad32(options.end) + '/~'
      : 'm/' + pad32(options.end) + '/~',
    limit: options.limit,
    reverse: options.reverse,
    transform: function(key) {
      key = key.split('/');
      if (account)
        return key[4];
      return key[3];
    }
  }, callback);
};

/**
 * Get transactions by timestamp range.
 * @param {Number?} account
 * @param {Object} options
 * @param {Number} options.start - Start height.
 * @param {Number} options.end - End height.
 * @param {Number?} options.limit - Max number of records.
 * @param {Boolean?} options.reverse - Reverse order.
 * @param {Function} callback - Returns [Error, {@link TX}[]].
 */

TXDB.prototype.getRange = function getLast(account, options, callback) {
  var self = this;
  var txs = [];

  if (typeof account === 'function') {
    callback = account;
    account = null;
  }

  this.getRangeHashes(account, options, function(err, hashes) {
    if (err)
      return callback(err);

    utils.forEachSerial(hashes, function(hash, next) {
      self.getTX(hash, function(err, tx) {
        if (err)
          return callback(err);

        if (!tx)
          return next();

        txs.push(tx);

        next();
      });
    }, function(err) {
      if (err)
        return callback(err);

      return callback(null, txs);
    });
  });
};

/**
 * Get last N transactions.
 * @param {Number?} account
 * @param {Number} limit - Max number of transactions.
 * @param {Function} callback - Returns [Error, {@link TX}[]].
 */

TXDB.prototype.getLast = function getLast(account, limit, callback) {
  if (typeof limit === 'function') {
    callback = limit;
    limit = account;
    account = null;
  }

  this.getRange(account, {
    start: 0,
    end: 0xffffffff,
    reverse: true,
    limit: limit
  }, callback);
};

/**
 * Get all transactions.
 * @param {Number?} account
 * @param {Function} callback - Returns [Error, {@link TX}[]].
 */

TXDB.prototype.getHistory = function getHistory(account, callback) {
  var self = this;
  var txs = [];

  if (typeof account === 'function') {
    callback = account;
    account = null;
  }

  this.getHistoryHashes(account, function(err, hashes) {
    if (err)
      return callback(err);

    utils.forEachSerial(hashes, function(hash, next) {
      self.getTX(hash, function(err, tx) {
        if (err)
          return callback(err);

        if (!tx)
          return next();

        txs.push(tx);

        next();
      });
    }, function(err) {
      if (err)
        return callback(err);

      return callback(null, utils.sortTX(txs));
    });
  });
};

/**
 * Get last active timestamp and height.
 * @param {Number?} account
 * @param {Function} callback - Returns [Error, Number(ts), Number(height)].
 */

TXDB.prototype.getLastTime = function getLastTime(account, callback) {
  var i, tx, lastTs, lastHeight;

  if (typeof account === 'function') {
    callback = account;
    account = null;
  }

  this.getHistory(account, function(err, txs) {
    if (err)
      return callback(err);

    lastTs = 0;
    lastHeight = -1;

    for (i = 0; i < txs.length; i++) {
      tx = txs[i];

      if (tx.ts > lastTs)
        lastTs = tx.ts;

      if (tx.height > lastHeight)
        lastHeight = tx.height;
    }

    return callback(null, lastTs, lastHeight);
  });
};

/**
 * Get unconfirmed transactions.
 * @param {Number?} account
 * @param {Function} callback - Returns [Error, {@link TX}[]].
 */

TXDB.prototype.getUnconfirmed = function getUnconfirmed(account, callback) {
  var self = this;
  var txs = [];

  if (typeof account === 'function') {
    callback = account;
    account = null;
  }

  this.getUnconfirmedHashes(account, function(err, hashes) {
    if (err)
      return callback(err);

    utils.forEachSerial(hashes, function(hash, next) {
      self.getTX(hash, function(err, tx) {
        if (err)
          return callback(err);

        if (!tx)
          return next();

        txs.push(tx);

        next();
      });
    }, function(err) {
      if (err)
        return callback(err);

      return callback(null, txs);
    });
  });
};

/**
 * Get coins.
 * @param {Number?} account
 * @param {Function} callback - Returns [Error, {@link Coin}[]].
 */

TXDB.prototype.getCoins = function getCoins(account, callback) {
  if (typeof account === 'function') {
    callback = account;
    account = null;
  }

  // Slow case
  if (account)
    return this.getAccountCoins(account, callback);

  // Fast case
  this.iterate({
    gte: 'c',
    lte: 'c~',
    keys: true,
    values: true,
    parse: function(value, key) {
      var parts = key.split('/');
      var hash = parts[3];
      var index = +parts[4];
      var coin = bcoin.coin.fromRaw(value);
      coin.hash = hash;
      coin.index = index;
      return coin;
    }
  }, callback);
};

/**
 * Get coins by account.
 * @param {Number} account
 * @param {Function} callback - Returns [Error, {@link Coin}[]].
 */

TXDB.prototype.getAccountCoins = function getCoins(account, callback) {
  var self = this;
  var coins = [];

  this.getCoinHashes(account, function(err, hashes) {
    if (err)
      return callback(err);

    utils.forEachSerial(hashes, function(key, next) {
      self.getCoin(key[0], key[1], function(err, coin) {
        if (err)
          return callback(err);

        if (!coin)
          return next();

        coins.push(coin);

        next();
      });
    }, function(err) {
      if (err)
        return callback(err);

      return callback(null, coins);
    });
  });
};

/**
 * Fill a transaction with coins (all historical coins).
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

TXDB.prototype.fillHistory = function fillHistory(tx, callback) {
  var hash, index, coin, input;

  if (tx.isCoinbase()) {
    callback = utils.asyncify(callback);
    return callback(null, tx);
  }

  hash = tx.hash('hex');

  this.iterate({
    gte: 'd/' + hash + '/' + pad32(0),
    lte: 'd/' + hash + '/' + pad32(0xffffffff),
    keys: true,
    values: true,
    parse: function(value, key) {
      index = +key.split('/')[4];
      coin = bcoin.coin.fromRaw(value);
      input = tx.inputs[index];
      coin.hash = input.prevout.hash;
      coin.index = input.prevout.index;
      input.coin = coin;
    }
  }, function(err) {
    if (err)
      return callback(err);
    return callback(null, tx);
  });
};

/**
 * Fill a transaction with coins.
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

TXDB.prototype.fillCoins = function fillCoins(tx, callback) {
  var self = this;

  if (tx.isCoinbase()) {
    callback = utils.asyncify(callback);
    return callback(null, tx);
  }

  utils.forEachSerial(tx.inputs, function(input, next) {
    var prevout = input.prevout;

    if (input.coin)
      return next();

    self.getCoin(prevout.hash, prevout.index, function(err, coin) {
      if (err)
        return callback(err);

      if (coin)
        input.coin = coin;

      next();
    });
  }, function(err) {
    if (err)
      return callback(err);
    return callback(null, tx);
  });
};

/**
 * Get transaction.
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

TXDB.prototype.getTX = function getTX(hash, callback) {
  this.fetch('t/' + hash, function(tx) {
    return bcoin.tx.fromExtended(tx);
  }, callback);
};

/**
 * Get transaction details.
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, {@link TXDetails}].
 */

TXDB.prototype.getDetails = function getDetails(hash, callback) {
  var self = this;
  this.getTX(hash, function(err, tx) {
    if (err)
      return callback(err);

    if (!tx)
      return callback();

    self.toDetails(tx, callback);
  });
};

/**
 * Convert transaction to transaction details.
 * @param {TX|TX[]} tx
 * @param {Function} callback
 */

TXDB.prototype.toDetails = function toDetails(tx, callback) {
  var self = this;
  var out;

  if (Array.isArray(tx)) {
    out = [];
    return utils.forEachSerial(tx, function(tx, next) {
      self.toDetails(tx, function(err, details) {
        if (err)
          return next(err);

        if (!details)
          return next();

        out.push(details);
        next();
      });
    }, function(err) {
      if (err)
        return callback(err);
      return callback(null, out);
    });
  }

  this.fillHistory(tx, function(err) {
    if (err)
      return callback(err);

    self.getInfo(tx, function(err, info) {
      if (err)
        return callback(err);

      if (!info)
        return callback();

      return callback(null, info.toDetails());
    });
  });
};

/**
 * Test whether the database has a transaction.
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, Boolean].
 */

TXDB.prototype.hasTX = function hasTX(hash, callback) {
  this.has('t/' + hash, callback);
};

/**
 * Get coin.
 * @param {Hash} hash
 * @param {Number} index
 * @param {Function} callback - Returns [Error, {@link Coin}].
 */

TXDB.prototype.getCoin = function getCoin(hash, index, callback) {
  var self = this;
  var key = hash + '/' + index;
  var coin = this.coinCache.get(key);

  if (coin) {
    try {
      coin = bcoin.coin.fromRaw(coin);
    } catch (e) {
      return callback(e);
    }
    coin.hash = hash;
    coin.index = index;
    return callback(null, coin);
  }

  this.fetch('c/' + key, function(data) {
    coin = bcoin.coin.fromRaw(data);
    coin.hash = hash;
    coin.index = index;
    self.coinCache.set(key, data);
    return coin;
  }, callback);
};

/**
 * Test whether the database has a transaction.
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, Boolean].
 */

TXDB.prototype.hasCoin = function hasCoin(hash, index, callback) {
  var key = hash + '/' + index;

  if (this.coinCache.has(key))
    return callback(null, true);

  this.has('c/' + key, callback);
};

/**
 * Calculate balance.
 * @param {Number?} account
 * @param {Function} callback - Returns [Error, {@link Balance}].
 */

TXDB.prototype.getBalance = function getBalance(account, callback) {
  var confirmed = 0;
  var unconfirmed = 0;

  if (typeof account === 'function') {
    callback = account;
    account = null;
  }

  // Slow case
  if (account)
    return this.getAccountBalance(account, callback);

  // Fast case
  this.iterate({
    gte: 'c',
    lte: 'c~',
    keys: true,
    values: true,
    parse: function(data) {
      var height = data.readUInt32LE(4, true);
      var value = utils.read64N(data, 8);

      assert(data.length >= 16);

      if (height === 0x7fffffff)
        unconfirmed += value;
      else
        confirmed += value;
    }
  }, function(err) {
    if (err)
      return callback(err);

    return callback(null, {
      confirmed: confirmed,
      unconfirmed: unconfirmed,
      total: confirmed + unconfirmed
    });
  });
};

/**
 * Calculate balance by account.
 * @param {Number} account
 * @param {Function} callback - Returns [Error, {@link Balance}].
 */

TXDB.prototype.getAccountBalance = function getBalance(account, callback) {
  var self = this;
  var confirmed = 0;
  var unconfirmed = 0;
  var key, coin;

  function parse(data) {
    var height = data.readUInt32LE(4, true);
    var value = utils.read64N(data, 8);

    assert(data.length >= 16);

    if (height === 0x7fffffff)
      unconfirmed += value;
    else
      confirmed += value;
  }

  this.getCoinHashes(account, function(err, hashes) {
    if (err)
      return callback(err);

    utils.forEachSerial(hashes, function(hash, next) {
      key = hash[0] + '/' + hash[1];
      coin = self.coinCache.get(key);

      if (coin) {
        try {
          parse(coin);
        } catch (e) {
          return next(e);
        }
        return next();
      }

      self.get('c/' + key, function(err, data) {
        if (err)
          return next(err);

        if (!data)
          return next();

        try {
          parse(data);
        } catch (e) {
          return callback(e);
        }

        self.coinCache.set(key, data);

        next();
      });
    }, function(err) {
      if (err)
        return callback(err);

      return callback(null, {
        confirmed: confirmed,
        unconfirmed: unconfirmed,
        total: confirmed + unconfirmed
      });
    });
  });
};

/**
 * @param {Number?} account
 * @param {Number} age - Age delta (delete transactions older than `now - age`).
 * @param {Function} callback
 */

TXDB.prototype.zap = function zap(account, age, callback, force) {
  var self = this;
  var unlock;

  if (typeof age === 'function') {
    force = callback;
    callback = age;
    age = account;
    account = null;
  }

  unlock = this._lock(zap, [account, age, callback], force);

  if (!unlock)
    return;

  callback = utils.wrap(callback, unlock);

  if (!utils.isNumber(age))
    return callback(new Error('Age must be a number.'));

  this.getRange(account, {
    start: 0,
    end: bcoin.now() - age
  }, function(err, txs) {
    if (err)
      return callback(err);

    utils.forEachSerial(txs, function(tx, next) {
      if (tx.ts !== 0)
        return next();
      self.remove(tx.hash('hex'), next, true);
    }, callback);
  });
};

/**
 * Abandon transaction.
 * @param {Hash} hash
 * @param {Function} callback
 */

TXDB.prototype.abandon = function abandon(hash, callback, force) {
  var self = this;
  this.has('p/' + hash, function(err, result) {
    if (err)
      return callback(err);

    if (!result)
      return callback(new Error('TX not found.'));

    self.remove(hash, callback, force);
  });
};

function Details(id, tx, table) {
  this.id = id;
  this.hash = tx.hash('hex');
  this.height = tx.height;
  this.block = tx.block;
  this.index = tx.index;
  this.confirmations = tx.getConfirmations();
  this.fee = tx.hasCoins() ? tx.getFee() : 0;
  this.ts = tx.ts;
  this.ps = tx.ps;
  this.tx = tx;
  this.inputs = [];
  this.outputs = [];
  this.init(table);
}

Details.prototype.init = function init(table) {
  this._insert(this.tx.inputs, this.inputs, table);
  this._insert(this.tx.outputs, this.outputs, table);
};

Details.prototype._insert = function _insert(vector, target, table) {
  var i, j, io, address, hash, paths, path, member;

  for (i = 0; i < vector.length; i++) {
    io = vector[i];
    member = new DetailsMember();

    if (io instanceof bcoin.input)
      member.value = io.coin ? io.coin.value : 0;
    else
      member.value = io.value;

    address = io.getAddress();

    if (address) {
      member.address = address;

      hash = address.getHash('hex');
      paths = table[hash];

      for (j = 0; j < paths.length; j++) {
        path = paths[j];
        if (path.id === this.id) {
          member.path = path;
          break;
        }
      }
    }

    target.push(member);
  }
};

Details.prototype.toJSON = function toJSON() {
  return {
    id: this.id,
    hash: utils.revHex(this.hash),
    height: this.height,
    block: this.block ? utils.revHex(this.block) : null,
    ts: this.ts,
    ps: this.ps,
    index: this.index,
    fee: utils.btc(this.fee),
    confirmations: this.confirmations,
    inputs: this.inputs.map(function(input) {
      return input.toJSON();
    }),
    outputs: this.outputs.map(function(output) {
      return output.toJSON();
    }),
    tx: this.tx.toRaw().toString('hex')
  };
};

function DetailsMember() {
  this.value = 0;
  this.address = null;
  this.path = null;
}

DetailsMember.prototype.toJSON = function toJSON() {
  return {
    value: utils.btc(this.value),
    address: this.address
      ? this.address.toBase58()
      : null,
    path: this.path
      ? this.path.toJSON()
      : null
  };
};

/*
 * Expose
 */

TXDB.Details = Details;
module.exports = TXDB;
