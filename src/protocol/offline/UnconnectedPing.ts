import MessageHeaders from '../MessageHeaders'
import OfflinePacket from '../UnconnectedPacket'

export default class UnconnectedPing extends OfflinePacket {
	public timestamp: bigint
	public constructor(buffer?: Buffer) {
		super(MessageHeaders.UNCONNECTED_PING, buffer)
	}

	// public clientGUID: bigint;

	public decodePayload() {
		this.timestamp = this.readLong()
		this.readMagic()
		// this.clientGUID = this.readLong();
	}

	public encodePayload() {
		this.writeLong(this.timestamp)
		this.writeMagic()
		// this.writeLong(this.clientGUID);
	}
}
