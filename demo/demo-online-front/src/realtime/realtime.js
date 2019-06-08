import gzip from '../lib/gzip'

export default class Rpc {

    openPromise
    sessionId
    sessionSecret
    openDone

    constructor(url, promise) {
        this.encrypt = true
        this.encryptKey = 'pan-light'
        this.url = url
        this.eventListener = {}
        this.requestMap = {}
        this.init(promise)
    }

    async init(promise) {
        this.openPromise = promise.then(c => {
            if (c)
                return this.connect()
            return Promise.reject('cancel connect')
        })
        this.onRemote('session.new', data => {
            this.sessionId = data.id
            this.sessionSecret = data.secret
        })

        this.onRemote('rand.check', data => {
            this.wsSend({'rand.back': data + 1})
            this.openDone()
        })

        setInterval(() => this.call('ping'), 10e3)
    }

    connect() {
        return new Promise((resolve) => {
            this.openDone = resolve
            const ws = this.ws = new WebSocket(this.url)
            if (this.encrypt) {
                ws.binaryType = 'arraybuffer'
            }
            ws.onopen = async evt => this.onWsOpen(evt)
            ws.onerror = evt => this.onWsError(evt)
            ws.onmessage = evt => this.onWsMessage(evt)
            ws.onclose = evt => this.onWsClose(evt)
        })
    }

    reconnnect() {
        this.ws.close()
        return this.connect()
    }


    onWsError(evt) {
        console.log('ws error', evt)
        let cbs = this.eventListener['rt.error'] || []
        cbs.forEach(function (cb) {
            setTimeout(function () {
                cb('realtime.error')
            })
        })
    }

    onWsClose(evt) {
        console.log('ws close', evt)
        let cbs = this.eventListener['realtime.closed'] || []
        cbs.forEach(function (cb) {
            setTimeout(function () {
                cb('realtime.closed')
            })
        })
        setTimeout(() => {
            this.reconnnect()
        }, 5e3)
    }

    onWsOpen() {
        if (this.sessionId) {
            this.wsSend({
                type: 'session.resume',
                sessionId: this.sessionId,
                sessionSecret: this.sessionSecret,
            })
        } else {
            this.wsSend({
                type: 'session.new'
            })
        }
        this.wsSend({
            role: 'user'
        })
    }

    wsSend(data) {
        if (!(data.type === 'call' && data.method === 'user.ping'))
            console.log('ws ->', data)
        let str = JSON.stringify(data)
        let send = this._encrypt(str)
        this.ws.send(send)
    }

    onWsMessage(evt) {
        const data = JSON.parse(this._decrypt(evt.data))
        if (!(
            (data.type === 'event' && data.event === 'ping') ||
            (data.type === 'call.result' && data.result === 'pong')
        )) {
            console.log('ws <-', data)
        }
        if (data.type === 'event') {
            let cbs = this.eventListener['$remote.' + data.event] || []
            cbs.forEach(function (cb) {
                setTimeout(function () {
                    cb(data.payload, data.room)
                })
            })
            if (data.room) {
                Room.handleRoomMsg(data, this)
            }
            return
        }
        if (data.type === 'call.result') {
            const {id, success} = data
            if (success) {
                this.requestMap[id].resolve(data.result)
            } else {
                this.requestMap[id].reject(data.error)
            }
            delete this.requestMap[id]
            return
        }
    }

    addEventListener(name, cb) {
        this.eventListener[name] = this.eventListener[name] || []
        this.eventListener[name].push(cb)
    }

    on(name, cb) {
        return this.addEventListener(name, cb)
    }

    onRemote(name, cb) {
        return this.on('$remote.' + name, cb)
    }

    call(method, param = {}) {
        method = 'user.' + method
        const id = 'cb' + new Date().getTime() + ~~(Math.random() * 1e5)
        let done = {}
        let promise = new Promise(function (resolve, reject) {
            done.resolve = resolve
            done.reject = reject
        })
        this.requestMap[id] = done
        this.wsSend({
            type: 'call',
            method,
            param,
            id
        })
        return promise
    }

    getRoom(name) {
        return Room.roomMap[name]
    }

    _encrypt(str) {
        if (!this.encrypt) {
            return str
        }
        let bin = gzip.zip(str)
        // console.log('发送, 压缩', bin)
        let cipher = new ArrayBuffer(bin.length)
        cipher = new Uint8Array(cipher)
        for (let i = 0; i < cipher.length; i++) {
            cipher[i] = bin[i] ^ this.encryptKey[i % this.encryptKey.length].charCodeAt(0)
        }
        // console.log('发送, 加密', cipher)
        return cipher.buffer
    }

    _decrypt(buf) {
        if (!this.encrypt) {
            return buf
        }
        let plain = Array.prototype.slice.call(new Uint8Array(buf), 0)
        plain.forEach((b, i) => {
            plain[i] ^= this.encryptKey[i % this.encryptKey.length].charCodeAt(0)
        })
        // console.log('接收, 明文', JSON.stringify(plain))
        let raw = gzip.unzip(plain)
        let bin = new ArrayBuffer(raw.length)
        bin = new Uint8Array(bin)
        for (let i = 0; i < bin.length; i++) {
            bin[i] = raw[i]
        }
        // console.log('接收, 解压', raw)
        return new TextDecoder("utf-8").decode(bin)
    }

}

class Room {
    name
    static roomMap = {}

    static handleRoomMsg(msg, rt) {
        let r = Room.roomMap[msg.room] || new Room(msg.room, rt)
        Room.roomMap[msg.room] = r
        r.handleMsg(msg)
    }

    constructor(name, rt) {
        this.name = name
        this.eventListener = new Map()
        ;(rt.eventListener['room.new'] || []).forEach(
            cb => {
                try {
                    cb(this)
                } catch (e) {
                    console.error(e)
                }
            }
        )
    }

    addEventListener(name, cb) {
        this.eventListener[name] = this.eventListener.get(name) || new Set()
        this.eventListener[name].add(cb)
    }

    off(name, cb) {
        this.eventListener[name] = this.eventListener.get(name) || new Set()
        this.eventListener[name].delete(cb)
    }

    on(name, cb) {
        return this.addEventListener(name, cb)
    }

    handleMsg(data) {
        let cbs = this.eventListener['$remote.' + data.event] || []
        cbs.forEach(function (cb) {
            setTimeout(function () {
                cb(data.payload)
            })
        })
    }
}
