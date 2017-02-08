// <img src=https://direape.solsort.com/icon.png width=96 height=96 align=right>
//
// [![website](https://img.shields.io/badge/website-direape.solsort.com-blue.svg)](https://direape.solsort.com/) 
// [![github](https://img.shields.io/badge/github-solsort/direape-blue.svg)](https://github.com/solsort/direape)
// [![codeclimate](https://img.shields.io/codeclimate/github/solsort/direape.svg)](https://codeclimate.com/github/solsort/direape)
// [![travis](https://img.shields.io/travis/solsort/direape.svg)](https://travis-ci.org/solsort/direape)
// [![npm](https://img.shields.io/npm/v/direape.svg)](https://www.npmjs.com/package/direape)
//
// # DireApe - Distributed Reactive App Environment
//
// *Unstable - under development - do not use it yet*
// 
// DireApe is an JavaScript library for making distributed reactive apps. It delivers:
// 
// - message passing between processes
// - a reactive world state
// 
// # Concepts
// 
// ## Processes / message parsing
// 
// DireApe facilitates communication between processes. Every process has a globally unique id `pid` and a set of named mailboxes. It is possible to send messages to a given "mailbox `@` process id".
// 
// The current supported processes are the browser main thread, and webworkers. The intention is to also send messages across the network, and to nodejs/workers.
// 
// ## Reactive state
// 
// Each process has a state that conceptually consist a consistent JSON-Object. The JSON-Object may also contain binary data, and is stored as an immmutable data structure, to allow fast diff'ing for reactive programming.
// 
// It is possible to add reactive functions to the state, such that they are called when the state changes.
// 
// # API implementation
//
var da = exports;
da.log = function() {};

// ## Defining handlers/reactions
//
// Keep track of the handlers/reactions. The keys are `name`, and the values are the corresponding functions.
//
// TODO: consider refactoring `handlers` to be a Map instead of an Object, - as we `delete`, which may be expensive.
//
da._handlers = {};

// `da.handle("name", (...parameters) => promise)` adds a new event handler. When `name` is run/called, the function is executed, the new state replaces the old state, and the return/reject of the promise is returned.
//
da.handle = (name, f) => {
  da._handlers[name] = f;
};

// `da.reaction(name, () => promise)` - adds a reactive handle, that is executed when the `name` is emitted, or the accessed parts of the state has changed.
//
da.reaction = (name, f) => {
  if(!f) {
    delete reactions[name];
    delete da._handlers[name];
  } else {
    da._handlers[name] = makeReaction(name, f);
    return da._handlers[name];
  }
};

// ## Process / messages
//
// `da.pid` is the unique id of the current process. randomString has enough entropy, that we know with a probability as high as human certainty that the id is globally unique.

var reun = require('reun');
da.pid = reun.pid || 'PID' + randomString();

self.onmessage = o => send(o.data);

// `da.run(pid, name, ...parameters)` executes a named handle in a process, and discards the result.

da.run = function direape_run(pid, name) {
  var params = slice(arguments, 2);
  send({dstPid: pid, dstName: name, params: params});
};

// `da.call(pid, name, ...parameters) => promise` executes a named handle in a process, and returns the result as a promise. This is done by registring a temporary callback handler.

da.call = function direape_call(pid, name) {
  //console.log('call', arguments);
  var params = slice(arguments, 2);
  return new Promise((resolve, reject) => {
    send({dstPid: pid, dstName: name, 
      srcPid: da.pid,
      srcName: callbackHandler((val, err) => {
        //console.log('got-result', name, val, err);
        if(err) {
          reject(err);
        } else {
          resolve(val);
        }
      }),
      params: params});
  });
};

// ## Accessing the application state
//
// The state is an immutable value, which is useful for diffing, comparison, etc. The value only contains a JSON+Binary-object, such that it can always be serialised.
//
// Exposing an immutable object may also be useful outside of the library may be useful later on. It is not exposed / publicly available yet, to avoid exposing the immutable data structure, and we may want to use something simpler than the `immutable` library.
//
// TODO: extend the api to make immutable value available. For example like `da.getIn([...keys], defaultVale) => Immutable`. This is also why the api is called setJS/getJS, - as setIn/getIn should return immutable values.

var immutable = require('immutable');
var state = new immutable.Map();

// `da.setJS([...keys], value)` sets a value, - only allowed to be called synchronously within a handler/reaction, to avoid race-conditions
// 
// Making a change may also trigger/schedule reaction to run later.

da.setJS = (path, value) => { 
  state = setJS(state, path, value); 
  reschedule();
};

// `da.getJS([...keys], defaultValue)` gets a value within the state

da.getJS = (path, defaultValue) => {
  var result = state.getIn(path);
  accessHistoryAdd(path);
  return result === undefined ? defaultValue :
    (result.toJS ? result.toJS() : result);
};

// ## Creating / killing children
// 
// Keep track of the child processes, by mapping their pid to their WebWorker object.
//
// TODO: may make sense to use a Map instead, as we do deletes.

var children = {};

// `da.spawn() => promise` spawn a new process, and return its pid as a promise.
//
// When the new worker is created, we send back and forth the pids, so the parent/children knows its child/parent. And then we also set up handling of messages.

da.spawn = () => new Promise((resolve, reject) => {
  var childPid = 'PID' + randomString();
  var workerSourceUrl = 
    (self.URL || self.webkitURL).createObjectURL(new Blob([`
          importScripts('https://unpkg.com/reun');
          reun.urlGet = function(url) { 
            return new Promise((resolve, reject) => {
              self.postMessage(url);
              self.onmessage = o => {
                resolve(o.data);
              };
            });
          };
          reun.pid = '${childPid}';
          reun.require('direape@0.1').then(da => {
          //reun.require('http://localhost:8080/direape.js').then(da => {
          //da.log = function() { console.log.apply(console,da._slice(arguments))};
          da.parent = '${da.pid}';
          reun.urlGet = url => da.call(da.parent, 'reun:url-get', url);
          self.postMessage({ready:true});
          });
          `], {type:'application/javascript'}));
        var child = new Worker(workerSourceUrl);
        children[childPid] = child;
        child.onmessage = o => {
          o = o.data;
          if(o.ready) {
            child.onmessage = o => send(o.data);
            return resolve(childPid);
          }
          reun.urlGet(o).then(val => {
            child.postMessage(val);
          });
        };
});

// `da.kill(pid)` kill a child process

da.kill = (pid) => {
  children[pid].terminate();
  delete children[pid];
};

// `da.children()` lists live child processes

da.children = () => Object.keys(children);


// # Built-in Handlers

da.handle('reun:url-get', reun.urlGet);
// setIn/getIn

da.handle('da:setIn', da.setJS);
da.handle('da:getIn', da.getJS);

// TODO: make `reun:run` result serialisable, currently we just discard it

da.handle('reun:run', (src,baseUrl) => 
    reun.run(src,baseUrl).then(o => jsonify(o)));

da.handle('da:subscribe', (path, opt) => 
    jsonify(da.reaction(`da:subscribe ${path} -> ${opt.name}@${opt.pid}`,
      () => da.run(opt.pid, opt.name, path, da.getJS(path)))));

da.handle('da:unsubscribe', (path, opt) => 
    da.reaction(`da:subscribe ${path} -> ${opt.name}@${opt.pid}`));
// TODO:
//
// - `da:subscribe(path, handlerName)` - call `da.run(da.pid, handlerName, path, value)` on changes
// - `da:unsubscribe(path, handlerName)`

// # Internal functions
//
// TODO more documentation in the rest of this file

function callbackHandler(f) {
  var id = 'callback:' + randomString();
  da._handlers[id] = function() {
    delete da._handlers[id];
    return f.apply(null, slice(arguments));
  };
  return id;
}

// ##  Setting af JS-value deeply inside an immutable json object
//
// Utility function for setting a value inside an immutable JSON object.
// The state is kept JSON-compatible, and thus we create Map/Object or List/Array depending on whether the key is a number or string.
//
// TODO: better error handling, ie handle wrong types, i.e. setting a number in an object or vice versa

function setJS(o, path, value) {
  /* TODO: check that we are in handler, or else throw */
  if(path.length) {
    var key = path[0];
    var rest = path.slice(1);
    if(!o) {
      if(typeof key === 'number') {
        o = new immutable.List();
      } else {
        o = new immutable.Map();
      }
    }
    return o.set(key, setJS(o.get(path[0]), path.slice(1), value));
  } else {
    return immutable.fromJS(value);
  }
}

// ## Handling access history for reactions
var accessHistory = undefined;
function accessHistoryAdd(path) {
  if(accessHistory) {
    accessHistory.add(JSON.stringify(path));
  }
}

// ## make reaction
// 
// The reactions object is used to keep track of which of the handlers that are reactions. 
//
// makeReaction, keeps track of whether a function is actually a reaction.
//
// TODO: think through whether there might be a bug: when a reaction is overwritten by a handler with the same name, - if the reaction is triggered, then it might call the handler?...
//
var reactions = {};
function makeReaction(name, f) {
  reactions[name] = new Set(['[]']);
  var reaction = function() {
    if(da._handlers[name] !== reaction) {
      delete reactions[name];
      return;
    } 
    var prevAccessHistory = accessHistory;
    accessHistory = new Set();
    try {
      f();
    } catch(e) {
      console.log('error during reaction', name, e);
    }
    if(reactions[name]) {
      reactions[name] = accessHistory;
    }
    accessHistory = prevAccessHistory;
  };
  return reaction;
}


// ## Event loop
//
var prevState = state;
var messageQueue = [];
var scheduled = false;

// ### request/schedule execution of reactions / sending pending messages

function reschedule() {
  if(!scheduled) {
    nextTick(handleMessages);
    scheduled = true;
  }
}

// ### Send a message

function send(msg) {
  da.log('send', msg);
  if(msg.dstPid === da.pid) {
    messageQueue.push(msg);
    reschedule();
  } else if(children[msg.dstPid]) {
    try {
      children[msg.dstPid].postMessage(msg);
    } catch(e) {
      try {
        children[msg.dstPid].postMessage(jsonify(msg));
      } catch(e2) {
        console.log('send error', msg, e2);
        throw e2;
      }
    }
  } else {
    try {
      self.postMessage(msg);
    } catch(e) {
      console.log('send error', msg, e);
      throw e;
    }
  }
}

// ### send a response to a message

function sendResponse(msg, params) {
  if(msg.srcPid && msg.srcName) {
    send({
      dstPid: msg.srcPid, 
      dstName: msg.srcName, 
      params: params});
  } 
}

// ### dispatch all messages in the message queue and run reactions

function handleMessages() {
  scheduled = false;
  if(messageQueue.length) {
    var messages = messageQueue;
    messageQueue = [];
    messages.forEach(handleMessage);
  }
  scheduleReactions();
}

// ### Request reactions to be executed

function scheduleReactions() {
  if(prevState.equals(state)) {
    return;
  }

  var name, accessedPaths, accessedPath, path, changed, prev, current;
  for (name in reactions) {
    accessedPaths = reactions[name];
    changed = false;
    for (accessedPath of accessedPaths) {
      path = JSON.parse(accessedPath);
      prev = prevState.getIn(path);
      current = state.getIn(path);
      if (prev !== current) {
        if ((prev instanceof immutable.Map || 
              prev instanceof immutable.List)
            && prev.equals(current)){
          continue;
        } 
        changed = true;
        break;
      }
    }
    if(changed) {
      send({dstPid: da.pid, dstName: name});
    }
  }
  prevState = state;
}

// ### Handle a single message

function handleMessage(msg) {
  da.log('handleMessage', msg);
  try {
    if(!da._handlers[msg.dstName]) {
      console.log('Missing handler: ' + msg.dstName);
      throw new Error('Missing handler: ' + msg.dstName);
    }
    Promise
      .resolve(da._handlers[msg.dstName].apply(null, msg.params))
      .then(o => sendResponse(msg, [o]), 
          e => sendResponse(msg, [null, jsonify(e)]));
  } catch(e) {
    sendResponse(msg, [null, jsonify(e)]);
  }
}


// ## Generic utility function
//
// May be temporarily exported, during development, but not intended to be used outside of module.

// TODO extract common code to common core library
da._jsonify = jsonify;
da._slice = slice;
da._jsonReplacer = jsonReplacer;

function jsonify(o) {
  return JSON.parse(JSON.stringify([o], (k,v) => jsonReplacer(v)))[0];
}

var jsonifyWhitelist = 
['stack', 'name', 'message', 
  'id', 'class', 'value'
];

function jsonReplacer(o) {
  if((typeof o !== 'object' && typeof o !== 'function') || o === null || Array.isArray(o) || o.constructor === Object) {
    return o;
  }
  var result, k, i;
  if(typeof o.length === 'number') {
    result = [];
    for(i = 0; i < o.length; ++i) {
      result[i] = o[i];
    }
  }
  result = Object.assign({}, o);
  if(o.constructor && o.constructor.name && result.$_class === undefined) {
    result.$_class = o.constructor.name;
  }
  if(o instanceof ArrayBuffer) {
    /* TODO btoa does not work in arraybuffer, 
     * and apply is probably slow.
     * Also handle Actual typed arrays,
     * in if above. */
    result.base64 = self.btoa(String.fromCharCode.apply(null, new Uint8Array(o)));
  }
  for(i = 0; i < jsonifyWhitelist.length; ++i) {
    k = jsonifyWhitelist[i] ;
    if(o[k] !== undefined) {
      result[k] = o[k];
    }
  }
  return result;
}

function randomString() {
  return Math.random().toString(32).slice(2) +
    Math.random().toString(32).slice(2) +
    Math.random().toString(32).slice(2);
}
function nextTick(f) {
  setTimeout(f, 0);
}
function slice(a, start, end) {
  return Array.prototype.slice.call(a, start, end);
}

// # Main / test
//
// this is currently just experimentation during development.
//
// TODO: replace this with proper testing

//console.log('started', da.pid);
da.main = () => {
  console.log('running', da.pid);
  reun.log = da.log = function() { console.log(slice(arguments)); };
  /*
     da.reaction('blah', () => {
     console.log('blah', da.getJS(['blah']));
     });

     da.setJS(['blah', 1, 'world'], 'hi');
     console.log('here', da.getJS(['blah']));

     da.handle('hello', (t) => {
     da.setJS(['blah'], '123');
     console.log('hello', t);
     return 'hello' + t;
     });
     da.run(da.pid, 'hello', 'world');
     da.call(da.pid, 'hello', 'to you').then(o => console.log(o));
     da.call(da.pid, 'hello', 'to me').then(o => console.log(o));
     da.setJS(['hi'], 'thread-1');
     */
  da.spawn().then(child => {
    da.handle('log', function () { console.log('log', arguments); });
    da.call(child, 'da:subscribe', ['hi'], {pid: da.pid, name: 'log'});
    da.call(child, 'reun:run', 
        'require("http://localhost:8080/direape.js").setJS(["hi"], "here");', 
        'http://localhost:8080/')
      .then(result => console.log('result', result))
      .then(() => da.call(child, 'da:getIn', ['hi'], 123))
      .then(o => console.log('call-result', o))
      .then(() => da.call(da.pid, 'da:getIn', ['hi'], 432))
      .then(o => console.log('call-result', o));
  });
  /*
     console.log(Object.keys(da));
     try {
     throw new Error();
     } catch(e) {
     console.log(jsonify(e));
     }
     console.log(undefined);
     document.body.onclick = function(e) {
     console.log(jsonify(e));
     };
     document.body.click();
     da.setJS(['foo'], 123);
     da.reaction('a', o => {
     console.log('a', da.getJS(['foo']));
     console.log('b', da.getJS(['baz']));
     });
     setTimeout(o => da.setJS(['bar'], 456), 200);
     setTimeout(o => da.setJS(['foo'], 789), 400);
     */
};

// # License
// 
// This software is copyrighted solsort.com ApS, and available under GPLv3, as well as proprietary license upon request.
// 
// Versions older than 10 years also fall into the public domain.
// 
// # Future ideas
//
// - Make the library truely functional, ie. `da` will be a monadic state which also implements being a promise.
// - Add API for creating a cached reactive function.
