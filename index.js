/*
 * JS Cortex Wrapper
 * *****************
 *
 * This library is intended to make working with Cortex easier in Javascript.
 * We use it both in the browser and NodeJS code.
 *
 * It makes extensive use of Promises for flow control; all requests return a
 * Promise with their result. To make it easier to chain together sequences of
 * operations, we use a special Promise subclass that lets us do things like
 * client.auth().createSession().subscribe() while still maintaining sensible
 * control flow and error handling.
 *
 * For the subscription types in Cortex, we use an event emitter. Each kind of
 * event (mot, eeg, etc) is emitted as its own event that you can listen for
 * whether or not there are any active subscriptions at the time.
 *
 * The API methods are defined by using Cortex's inspectApi call. We mostly
 * just pass information back and forth without doing much with it, with the
 * exception of the login/auth flow, which we expose as the init() method.
 */

const EventEmitter = require('events')

const CORTEX_URL = 'wss://emotivcortex.com:54321'

const safeParse = (msg) => { try { return JSON.parse(msg) } catch (_) { return null } }

const makeChainablePromise = (parent) => {
  class ChainablePromise extends Promise {
    static proxy (method) {
      if (this.prototype[method]) return

      this.prototype[method] = function (...args) {
        return this.then(() => parent[method](...args))
      }
    }
  }
  const proto = parent.constructor ? parent.constructor.prototype : {}
  for (const method of Object.getOwnPropertyNames(proto)) {
    if (typeof parent[method] === 'function' &&
        method[0] !== '_' &&
        method !== 'constructor') {
      ChainablePromise.proxy(method)
    }
  }
  return ChainablePromise
}

if (global.process) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
}

class JSONRPCError extends Error {
  constructor (err) {
    super(err.message)
    this.name = this.constructor.name
    this.message = err.message
    this.code = err.code
  }
  toString () {
    return super.toString() + ` (${this.code})`
  }
}

class Cortex extends EventEmitter {
  constructor (options = {}) {
    super()
    this.options = options
    this.ws = new WebSocket(CORTEX_URL)
    this.msgId = 0
    this.requests = {}
    this.streams = {}
    this.ws.addEventListener('message', this._onmsg.bind(this))
    this.ws.addEventListener('close', () => {
      this._log('ws: Socket closed')
      this.call = () => this.APIResult.reject(new Error('socket closed'))
    })
    this.verbose = options.verbose !== null ? options.verbose : 1
    this.APIResult = makeChainablePromise(this)

    this.ready =
      new this.APIResult(resolve => this.ws.addEventListener('open', resolve))
        .then(() => this._log('ws: Socket opened'))
        .call('inspectApi')
        .then(methods => {
          for (const m of methods) this.defineMethod(m.methodName, m.params)
          this._log(`rpc: Added ${methods.length} methods from inspectApi`)
        })
  }
  _onmsg (msg) {
    const data = safeParse(msg.data)
    if (!data) return this._warn('unparseable message', msg)

    this._debug('ws: <-', msg.data)

    if ('id' in data) {
      const id = data.id
      this._log(`[${id}] <-`, data.result ? 'success' : `error (${data.error.message})`)
      if (this.requests[id]) {
        this.requests[id](data.error, data.result)
      } else {
        this._warn('rpc: Got response for unknown id', id)
      }
    } else if ('sid' in data) {
      const dataKeys = Object.keys(data).filter(k =>
        k !== 'sid' && k !== 'time' && Array.isArray(data[k])
      )
      for (const k of dataKeys) {
        this.emit(k, data) || this._warn('no listeners for stream event', k)
      }
    } else {
      this._log('rpc: Unrecognised data', data)
    }
  }
  _warn (...msg) {
    if (this.verbose > 0) console.warn('[Cortex WARN]', ...msg)
  }
  _log (...msg) {
    if (this.verbose > 1) console.warn('[Cortex LOG]', ...msg)
  }
  _debug (...msg) {
    if (this.verbose > 2) console.warn('[Cortex DEBUG]', ...msg)
  }
  init ({username, password, client_id, client_secret, debit} = {}) {
    const result = this.getUserLogin()
      .then(users => {
        if (users[0] && users[0] !== username) {
          this._log('init: Logging out other user', users[0])
          return this.logout({username: users[0]}).then(() => [])
        }
        if (username) {
          this._log('init: Reusing existing login')
        } else {
          this._log('init: Logging in anonymously')
        }
        return users
      })
      .then(users => {
        if (!users[0] && username && password) {
          this._log('init: Logging in as', username)
          return this.login({username, password, client_id, client_secret})
        }
      })
      .authorize({client_id, client_secret, debit}).then(({_auth}) => {
        this._log('init: Got auth token')
        this._debug('init: Auth token', _auth)
        this._auth = _auth
      })

    return result
  }
  close () {
    return new this.APIResult((resolve) => {
      this.ws.close()
      this.ws.once('close', resolve)
    })
  }
  call (method, params = {}) {
    const id = this.msgId++
    const msg = JSON.stringify({jsonrpc: '2.0', method, params, id})
    this.ws.send(msg)
    this._log(`[${id}] -> ${method}`)

    this._debug('ws: ->', msg)
    return new this.APIResult((resolve, reject) => {
      this.requests[id] = (err, data) => {
        delete this.requests[id]
        this._debug('rpc: err', err, 'data', data)
        if (err) return reject(new JSONRPCError(err))
        if (data) return resolve(data)
        return reject(new Error('Invalid JSON-RPC response'))
      }
    })
  }
  defineMethod (methodName, paramDefs = []) {
    if (this[methodName]) return
    const needsAuth = paramDefs.some(p => p.name === '_auth')
    const requiredParams = paramDefs.filter(p => p.required).map(p => p.name)

    this[methodName] = (params = {}) => {
      if (needsAuth && this._auth && !params._auth) {
        params = Object.assign({}, params, {_auth: this._auth})
      }
      const missingParams = requiredParams.filter(p => params[p] == null)
      if (missingParams.length > 0) {
        return this.APIResult.reject(
          new Error(`Missing required params for ${methodName}: ${missingParams.join(', ')}`)
        )
      }
      return this.call(methodName, params)
    }

    this.APIResult.proxy(methodName)
  }
}

Cortex.JSONRPCError = JSONRPCError
Cortex.makeChainablePromise = makeChainablePromise

module.exports = Cortex

var _auth ="";
var session = "";

var auth = {
    client_id: "...",
    client_secret: "...",
    debit: 1 // first time you run example debit should > 0
}

function init (client) {
    $("#messages").text("");
    auth.username = $("#emotiv_id").val();
    auth.password = $("#password").val();
    return client
    .login(auth)
    .then(() => {
        return client
            .authorize(auth).then((token) => {
                _auth = token._auth;
        })
    }, (err) => {
        $("#messages").text(err);
    })
    .then(() => {
        return client.queryHeadsets()}, (err) => {
        $("#messages").text(...auguments);
    })
    .then((headsets) => {
        console.log('headsets', headsets);
        if (headsets.length > 0){
            headset = headsets[0].id;
            return client.createSession({
                _auth: _auth,
                status: 'active',
                headset: headset,
                "project": "webapp",
                "title": "session_title goes here",
                "experimentID": 31313
            })
            .then((response) => {
                session = response.id;
                console.log('session_id', session)
            }, (err) => {
                $("#messages").text(err);
            });
        } else {
            $("#messages").text("No headset found!!!");
        }
    })
}

// Here we enable the buttons and initialize our Cortex client
(function($){

    const verbose = 5
    const options = {verbose}
    const client = new Cortex(options)

    $("#start").click(()=> {
        init(client);
    });
    $("#stop").click(()=> {
        client.updateSession({
            _auth: _auth,
            session: session,
            status: "close"}).then(() => {
            console.log('Finished');
        });
    });
    $("#mark").click(() => {
        var time = Date.now()
        var value = $("#marker_value").val()
        if ($.isNumeric(value)) {
            value = parseInt(value);
        }
        client.injectMarker({
            _auth: _auth,
            session: session,
            label:"click", 
            value: value, 
            port: "webapp",
            time: time})
        .then(() => console.log('Marker Set'), (err) => {
            console.log('Problem setting marker', err)
        })
    });
    $("#mark_stop").click( () => {
        var time = Date.now()
        var value = $("#marker_value").val()
        if ($.isNumeric(value)) {
            value = parseInt(value);
        }
        client.injectMarker({
            _auth: _auth,
            session: session,
            label:"click", 
            stop: value, 
            port: "webapp",
            time: time})
        .then(() => console.log('Stop marker Set'), (err) => {
            console.log('Problem setting stop marker', err)
        })
    });
})(jQuery);
