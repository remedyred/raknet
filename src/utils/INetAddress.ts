export default class INetAddress {
	protected readonly address: string
	protected readonly port: number
	protected readonly version: number

	public constructor(address: string, port: number, version = 4) {
		this.address = address
		this.port = port
		this.version = version
	}

	public getAddress(): string {
		return this.address
	}

	public getPort(): number {
		return this.port
	}

	public getVersion(): number {
		return this.version
	}

	public toToken(): string {
		return `${this.address}:${this.port}`
	}
}
