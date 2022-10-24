import MessageHeaders from '../MessageHeaders'
import Packet from '../Packet'

export default class ConnectedPong extends Packet {
	public clientTimestamp: bigint
	public serverTimestamp: bigint
	public constructor() {
		super(MessageHeaders.CONNECTED_PONG)
	}

	public encodePayload(): void {
		this.writeLong(this.clientTimestamp)
		this.writeLong(this.serverTimestamp)
	}
}
