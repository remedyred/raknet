import {EventEmitter} from 'events'

import {RAKNET_TPS} from './common'
import {RemoteInfo} from 'dgram'
import * as dgram from 'dgram'
import BitFlags from './protocol/BitFlags'
import Packet from './protocol/Packet'
import Session from './Session'
import UnconnectedHandler from './protocol/UnconnectedHandler'

export default class Listener extends EventEmitter {
	protected readonly guid: bigint
	protected readonly sessions: Map<string, Session> = new Map()
	protected readonly socket: dgram.Socket
	protected readonly onlineMode: boolean

	public constructor(onlineMode = true) {
		super()
		this.socket = dgram.createSocket('udp4')
		this.onlineMode = onlineMode
		this.guid = Buffer.allocUnsafe(8).readBigInt64BE()
	}

	public kill(): void {
		// Send last remaining packets to all players
		for (const session of this.getSessions()) {
			session.sendFrameQueue()
		}
	}

	public addSession(rinfo: RemoteInfo, mtuSize: number) {
		this.sessions.set(`${rinfo.address}:${rinfo.port}`, new Session(this, mtuSize, rinfo, this.onlineMode))
	}

	public removeSession(session: Session, reason?: string): void {
		if (this.sessions.delete(session.getAddress().toToken())) {
			this.emit('closeConnection', session.getAddress(), reason)
		}
	}

	public getSessions(): Session[] {
		return [...this.sessions.values()]
	}

	protected getSession(rinfo: RemoteInfo): Session | null {
		return this.sessions.get(`${rinfo.address}:${rinfo.port}`) ?? null
	}

	public getServerGuid(): bigint {
		return this.guid
	}

	public sendPacket<T extends Packet>(packet: T, rinfo: RemoteInfo): void {
		packet.encode()
		this.sendBuffer(packet.getBuffer(), rinfo)
	}

	public sendBuffer(buffer: Buffer, rinfo: RemoteInfo): void {
		this.socket.send(buffer, rinfo.port, rinfo.address)
	}

	public async start(address: string, port: number): Promise<Listener> {
		return new Promise((resolve, reject) => {
			const failFn = (e: Error) => {
				reject(e)
			}

			const unconnHandler = new UnconnectedHandler(this)

			this.socket.once('error', failFn)
			this.socket.bind(port, address, () => {
				this.socket.removeListener('error', failFn)
				this.socket.on('message', async (msg, rinfo) => {
					if ((msg.readUint8() & BitFlags.VALID) === 0) {
						unconnHandler.handle(msg, rinfo)
					} else {
						this.getSession(rinfo)?.handle(msg)
					}
				})

				setInterval(() => {
					for (const session of this.sessions.values()) {
						if (session.isDisconnected()) {
							this.removeSession(session)
							return
						}
						session.update(Date.now())
					}
				}, RAKNET_TPS)

				resolve(this)
			})
		})
	}
}
