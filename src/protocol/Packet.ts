import BinaryStream from '@jsprismarine/jsbinaryutils'
import INetAddress from '../utils/INetAddress'

export default class Packet extends BinaryStream {
	private readonly id: number

	public constructor(id: number, buffer?: Buffer) {
		super(buffer)
		this.id = id
	}

	public getId(): number {
		return this.id
	}

	public decode(): void {
		this.readByte()
	}

	public encode() {
		this.writeByte(this.getId())
	}

	public readString(): string {
		return this.read(this.readShort()).toString('utf8')
	}

	public writeString(v: string): void {
		const data = Buffer.from(v, 'utf8')
		this.writeUnsignedShort(data.byteLength)
		this.write(data)
	}

	public readAddress(): INetAddress {
		const ver = this.readByte()
		if (ver === 4) {
			const ipBytes = this.read(4)
			const addr = `${(-ipBytes[0] - 1) & 0xFF}.${(-ipBytes[1] - 1) & 0xFF}.${(-ipBytes[2] - 1) & 0xFF}.${
				(-ipBytes[3] - 1) & 0xFF
			}`
			const port = this.readShort()
			return new INetAddress(addr, port, ver)
		}

		this.skip(2) // Skip 2 bytes
		const port = this.readShort()
		this.skip(4) // Skip 4 bytes
		const addr = this.read(16).toString()
		this.skip(4) // Skip 4 bytes
		return new INetAddress(addr, port, ver)
	}

	public writeAddress(address: INetAddress): void {
		this.writeByte(4) // IPv4 only
		const bytes = address
			.getAddress()
			.split('.', 4)
			.map(v => Number.parseInt(v, 10))
		// 10 should work perfectly fine, but maybe base2 is directly better...
		// TODO: see when will refactor this code soon
		for (const byte of bytes) {
			this.writeByte(~byte & 0xFF)
		}
		this.writeUnsignedShort(address.getPort())
	}
}
