import INetAddress from '../../utils/INetAddress'
import MessageHeaders from '../MessageHeaders'
import Packet from '../Packet'

export default class ConnectionRequestAccepted extends Packet {
	public clientAddress: INetAddress
	public requestTimestamp: bigint
	public acceptedTimestamp: bigint
	public constructor(buffer?: Buffer) {
		super(MessageHeaders.CONNECTION_REQUEST_ACCEPTED, buffer)
	}

	public decodePayload(): void {
		this.clientAddress = this.readAddress()
		this.readShort() // Unknown
		for (let i = 0; i < 20; i++) {
			this.readAddress()
		}

		this.requestTimestamp = this.readLong()
		this.acceptedTimestamp = this.readLong()
	}

	public encodePayload(): void {
		this.writeAddress(this.clientAddress)
		this.writeShort(0) // Unknown
		const sysAddresses = [new INetAddress('127.0.0.1', 0, 4)]
		for (let i = 0; i < 20; i++) {
			this.writeAddress(sysAddresses[i] ?? new INetAddress('0.0.0.0', 0, 4))
		}

		this.writeLong(this.requestTimestamp)
		this.writeLong(this.acceptedTimestamp)
	}
}
