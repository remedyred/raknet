import INetAddress from '../../utils/INetAddress'
import MessageHeaders from '../MessageHeaders'
import OfflinePacket from '../UnconnectedPacket'

export default class OpenConnectionReply2 extends OfflinePacket {
	public serverGuid: bigint
	public clientAddress: INetAddress
	public mtuSize: number
	public constructor(buffer?: Buffer) {
		super(MessageHeaders.OPEN_CONNECTION_REPLY_2, buffer)
	}

	public decodePayload(): void {
		this.readMagic()
		this.serverGuid = this.readLong()
		this.clientAddress = this.readAddress()
		this.mtuSize = this.readUnsignedShort()
		this.readByte() // Secure
	}

	public encodePayload(): void {
		this.writeMagic()
		this.writeLong(this.serverGuid)
		this.writeAddress(this.clientAddress)
		this.writeUnsignedShort(this.mtuSize)
		this.writeByte(0) // Secure
	}
}
