import {RemoteInfo} from 'dgram'
import {MAX_CHANNELS} from './common'
import Ack from './protocol/Ack'
import BinaryStream from '@jsprismarine/jsbinaryutils'
import BitFlags from './protocol/BitFlags'
import ConnectedPing from './protocol/connection/ConnectedPing'
import ConnectedPong from './protocol/connection/ConnectedPong'
import ConnectionRequest from './protocol/login/ConnectionRequest'
import ConnectionRequestAccepted from './protocol/login/ConnectionRequestAccepted'
import Frame from './protocol/Frame'
import FrameReliability from './protocol/FrameReliability'
import FrameSet from './protocol/FrameSet'
import INetAddress from './utils/INetAddress'
import MessageHeaders from './protocol/MessageHeaders'
import Nack from './protocol/Nack'
import Packet from './protocol/Packet'
import Listener from './Listener'
import assert from 'assert'

export enum RakNetPriority {
	NORMAL,
	IMMEDIATE
}

export enum RakNetStatus {
	CONNECTING,
	CONNECTED,
	DISCONNECTING,
	DISCONNECTED
}

export default class Session {
	protected readonly listener: Listener
	protected readonly mtuSize: number
	protected readonly rinfo: RemoteInfo

	protected readonly offlineMode: boolean

	protected state = RakNetStatus.CONNECTING

	protected outputFrameQueue = new FrameSet()
	protected outputSequenceNumber = 0
	protected outputReliableIndex = 0
	protected outputSequenceIndex = 0
	protected readonly outputBackupQueue = new Map<number, FrameSet>()

	protected receivedFrameSequences = new Set<number>()
	protected lostFrameSequences = new Set<number>()

	// Map holding fragments of fragmented packets
	protected readonly fragmentsQueue = new Map<number, Map<number, Frame>>()
	protected outputFragmentIndex = 0

	protected lastInputSequenceNumber = -1
	protected readonly inputHighestSequenceIndex: number[]
	protected readonly inputOrderIndex: number[]
	protected inputOrderingQueue = new Map<number, Map<number, Frame>>()

	protected readonly channelIndex: number[]

	// Last timestamp of packet received, helpful for timeout
	protected lastUpdate: number = Date.now()
	protected active = true

	public constructor(listener: Listener, mtuSize: number, rinfo: RemoteInfo, offlineMode = false) {
		this.listener = listener

		this.mtuSize = mtuSize
		this.rinfo = rinfo
		this.offlineMode = offlineMode

		this.lastUpdate = Date.now()

		this.channelIndex = Array.from<number>({length: MAX_CHANNELS}).fill(0)
		this.inputOrderIndex = Array.from<number>({length: MAX_CHANNELS}).fill(0)
		this.inputHighestSequenceIndex = Array.from<number>({length: MAX_CHANNELS}).fill(0)
	}

	public update(timestamp: number): void {
		if (!this.isActive() && this.lastUpdate + 10_000 < timestamp) {
			this.disconnect('timeout')
			return
		}

		this.active = false

		// TODO: a queue just for ACKs sequences to avoid duplicateds
		if (this.receivedFrameSequences.size > 0) {
			const ack = new Ack()
			ack.sequenceNumbers = [...this.receivedFrameSequences].map(seq => {
				this.receivedFrameSequences.delete(seq)
				return seq
			})
			this.sendPacket(ack)
		}

		if (this.lostFrameSequences.size > 0) {
			const pk = new Nack()
			pk.sequenceNumbers = [...this.lostFrameSequences].map(seq => {
				this.lostFrameSequences.delete(seq)
				return seq
			})
			this.sendPacket(pk)
		}

		this.sendFrameQueue()
	}

	public handle(buffer: Buffer): void {
		this.active = true
		this.lastUpdate = Date.now()

		const header = buffer[0]
		if (header & BitFlags.ACK) {
			const ack = new Ack(buffer)
			ack.decode()
			this.handleACK(ack)
		} else if (header & BitFlags.NACK) {
			const nack = new Nack(buffer)
			nack.decode()
			this.handleNACK(nack)
		} else {
			const frameSet = new FrameSet(buffer)
			frameSet.decode()
			this.handleFrameSet(frameSet)
		}
	}

	protected handleFrameSet(frameSet: FrameSet): void {
		// Check if we already received packet and so we don't handle them
		if (this.receivedFrameSequences.has(frameSet.sequenceNumber)) {
			return
		}

		// Check if the packet was a missing one, so in the nack queue
		// if it was missing, remove from the queue because we received it now
		if (this.lostFrameSequences.has(frameSet.sequenceNumber)) {
			// May not need condition, to check
			this.lostFrameSequences.delete(frameSet.sequenceNumber)
		} else if (
			frameSet.sequenceNumber < this.lastInputSequenceNumber ||
			frameSet.sequenceNumber === this.lastInputSequenceNumber
		) {
			return
		}

		// Add the packet to the 'sent' queue
		// to let know the game we sent the packet
		this.receivedFrameSequences.add(frameSet.sequenceNumber)

		// Add the packet to the received window, a property that keeps
		// all the sequence numbers of packets we received
		// its function is to check if when we lost some packets
		// check wich are really lost by searching if we received it there
		this.receivedFrameSequences.add(frameSet.sequenceNumber)

		// Check if there are missing packets between the received packet and the last received one
		const diff = frameSet.sequenceNumber - this.lastInputSequenceNumber

		// Check if the sequence has a hole due to a lost packet
		if (diff !== 1) {
			// As i said before, there we search for missing packets in the list of the recieved ones
			for (let i = this.lastInputSequenceNumber + 1; i < frameSet.sequenceNumber; i++) {
				// Adding the packet sequence number to the Nack queue and then sending a Nack
				// will make the Client sending again the lost packet
				if (!this.receivedFrameSequences.has(i)) {
					this.lostFrameSequences.add(i)
				}
			}
		}

		// If we received a lost packet we sent in Nack or a normal sequenced one
		this.lastInputSequenceNumber = frameSet.sequenceNumber

		// Handle encapsulated
		for (const frame of frameSet.frames) {
			this.receiveFrame(frame)
		}
	}

	protected handleACK(ack: Ack): void {
		// TODO: ping calculation

		for (const seq of ack.sequenceNumbers) {
			this.receivedFrameSequences.delete(seq)
			this.outputBackupQueue.delete(seq)
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	protected handleNACK(_: Nack): void {
		// TODO: properly handle NACKs
		// for (const seq of nack.sequenceNumbers) {
		//    console.log(`NAKC ${seq}`);
		//    const pk = this.outputBackupQueue.get(seq) ?? null;
		//    if (pk != null) {
		//        pk.sequenceNumber = this.outputSequenceNumber++;
		//        pk.reset();
		//        pk.encode();
		//        this.sendFrameSet(pk);
		//        this.outputBackupQueue.delete(seq);
		//    }
		// }
	}

	protected receiveFrame(frame: Frame): void {
		if (frame.isFragmented()) {
			this.handleFragment(frame)
			return
		}

		const orderChannel = frame.orderChannel
		const orderIndex = frame.orderIndex
		const sequenceIndex = frame.sequenceIndex

		if (frame.isSequenced()) {
			// Packet is too old, discard it
			if (
				sequenceIndex < this.inputHighestSequenceIndex[orderChannel] ||
				orderIndex < this.inputOrderIndex[orderChannel]
			) {
				return
			}

			this.inputHighestSequenceIndex[orderChannel] = sequenceIndex + 1
			this.handlePacket(frame)
		} else if (frame.isOrdered()) {
			if (!this.inputOrderingQueue.has(orderChannel)) {
				this.inputOrderingQueue.set(orderChannel, new Map())
			}

			if (orderIndex === this.inputOrderIndex[orderChannel]) {
				this.inputHighestSequenceIndex[orderIndex] = 0
				this.inputOrderIndex[orderChannel] = orderIndex + 1

				this.handlePacket(frame)
				let i = this.inputOrderIndex[orderChannel]
				const outOfOrderQueue = this.inputOrderingQueue.get(orderChannel)
				for (; outOfOrderQueue.has(i); i++) {
					const packet = outOfOrderQueue.get(i)
					this.handlePacket(packet)
					outOfOrderQueue.delete(i)
				}

				this.inputOrderIndex[orderChannel] = i
			} else if (orderIndex > this.inputOrderIndex[orderChannel]) {
				this.inputOrderingQueue.get(orderChannel).set(orderIndex, frame)
			}
		} else {
			this.handlePacket(frame)
		}
	}

	public sendFrame(frame: Frame, flags = RakNetPriority.NORMAL): void {
		assert(typeof frame.orderChannel === 'number', 'Frame OrderChannel cannot be null')
		if (frame.isOrdered()) {
			// Sequenced packets don't increase the ordered channel index
			frame.orderIndex = frame.isSequenced() ? this.channelIndex[frame.orderChannel] : this.channelIndex[frame.orderChannel]++
		} else if (frame.isSequenced()) {
			frame.sequenceIndex = this.outputSequenceIndex++
		}

		// Split packet if bigger than MTU size
		const maxMtu = this.mtuSize - 36
		if (frame.getByteLength() + 4 > maxMtu) {
			// Split the buffer into chunks
			const buffers = new Map<number, Buffer>()
			let index = 0
			let splitIndex = 0

			while (index < frame.content.byteLength) {
				// Push format: [chunk index: int, chunk: buffer]
				buffers.set(splitIndex++, frame.content.subarray(index, (index += maxMtu)))
			}

			const fragmentId = this.outputFragmentIndex++ % 65_536
			for (const [index, buffer] of buffers) {
				const newFrame = new Frame()
				newFrame.reliability = frame.reliability
				newFrame.fragmentId = fragmentId
				newFrame.fragmentSize = buffers.size
				newFrame.fragmentIndex = index
				newFrame.content = buffer

				if (newFrame.isReliable()) {
					newFrame.reliableIndex = this.outputReliableIndex++
				}

				newFrame.sequenceIndex = frame.sequenceIndex
				newFrame.orderChannel = frame.orderChannel
				newFrame.orderIndex = frame.orderIndex

				this.addFrameToQueue(newFrame, flags)
			}
		} else {
			if (frame.isReliable()) {
				frame.reliableIndex = this.outputReliableIndex++
			}
			this.addFrameToQueue(frame, flags)
		}
	}

	protected addFrameToQueue(frame: Frame, priority = RakNetPriority.NORMAL): void {
		if (this.outputFrameQueue.getByteLength() + frame.getByteLength() > this.mtuSize) {
			this.sendFrameQueue()
		}

		this.outputFrameQueue.frames.push(frame)

		if (priority === RakNetPriority.IMMEDIATE) {
			this.sendFrameQueue()
		}
	}

	protected handlePacket(packet: Frame): void {
		const id = packet.content[0]

		if (this.state === RakNetStatus.CONNECTING) {
			if (id === MessageHeaders.CONNECTION_REQUEST) {
				this.handleConnectionRequest(packet.content).then(encapsulated => this.sendFrame(encapsulated, RakNetPriority.IMMEDIATE))
			} else if (id === MessageHeaders.NEW_INCOMING_CONNECTION) {
				// TODO: online mode
				this.state = RakNetStatus.CONNECTED
				this.listener.emit('openConnection', this)
			}
		} else if (id === MessageHeaders.DISCONNECT_NOTIFICATION) {
			this.disconnect('client disconnect')
		} else if (id === MessageHeaders.CONNECTED_PING) {
			this.handleConnectedPing(packet.content).then(encapsulated => this.sendFrame(encapsulated, RakNetPriority.IMMEDIATE))
		} else if (this.state === RakNetStatus.CONNECTED) {
			this.listener.emit('encapsulated', packet, this.getAddress()) // To fit in software needs later
		}
	}

	public handleFragment(frame: Frame): void {
		if (!this.fragmentsQueue.has(frame.fragmentId)) {
			this.fragmentsQueue.set(frame.fragmentId, new Map([ [frame.fragmentIndex, frame] ]))
		} else {
			const value = this.fragmentsQueue.get(frame.fragmentId)
			value.set(frame.fragmentIndex, frame)
			this.fragmentsQueue.set(frame.fragmentIndex, value)

			// If we have all pieces, put them together
			if (value.size === frame.fragmentSize) {
				const stream = new BinaryStream()
				// Ensure the correctness of the buffer orders
				for (let i = 0; i < value.size; i++) {
					const splitPacket = value.get(i)
					stream.write(splitPacket.content)
				}

				const assembledFrame = new Frame()
				assembledFrame.content = stream.getBuffer()
				assembledFrame.reliability = frame.reliability
				if (frame.isOrdered()) {
					assembledFrame.orderIndex = frame.orderIndex
					assembledFrame.orderChannel = frame.orderChannel
				}

				this.fragmentsQueue.delete(frame.fragmentId)
				this.receiveFrame(assembledFrame)
			}
		}
	}

	public sendFrameQueue(): void {
		if (this.outputFrameQueue.frames.length > 0) {
			this.outputFrameQueue.sequenceNumber = this.outputSequenceNumber++
			this.sendFrameSet(this.outputFrameQueue)
			this.outputFrameQueue = new FrameSet()
		}
	}

	protected sendFrameSet(frameSet: FrameSet): void {
		this.sendPacket(frameSet)
		this.outputBackupQueue.set(frameSet.sequenceNumber, frameSet)
	}

	protected sendPacket(packet: Packet): void {
		this.listener.sendPacket(packet, this.rinfo)
	}

	public close(): void {
		const stream = new BinaryStream(Buffer.from('\u0000\u0000\u0008\u0015', 'binary'))
		this.addFrameToQueue(new Frame().fromBinary(stream), RakNetPriority.IMMEDIATE) // Client discconect packet 0x15
	}

	/**
	 * Kick a client
	 * @param reason the reason message, optional
	 */
	public disconnect(reason?: string): void {
		this.state = RakNetStatus.DISCONNECTED
		this.close()
		this.listener.removeSession(this, reason ?? '')
	}

	public getState(): number {
		return this.state
	}

	public isActive(): boolean {
		return this.active
	}

	public isDisconnected(): boolean {
		return this.state === RakNetStatus.DISCONNECTED
	}

	public getListener(): Listener {
		return this.listener
	}

	public getAddress(): INetAddress {
		return new INetAddress(this.rinfo.address, this.rinfo.port, 4)
	}

	public async handleConnectionRequest(buffer: Buffer): Promise<Frame> {
		const dataPacket = new ConnectionRequest(buffer)
		dataPacket.decode()

		const pk = new ConnectionRequestAccepted()
		pk.clientAddress = this.getAddress()
		pk.requestTimestamp = dataPacket.requestTimestamp
		pk.acceptedTimestamp = BigInt(Date.now())
		pk.encode()

		const sendPacket = new Frame()
		sendPacket.reliability = FrameReliability.RELIABLE_ORDERED
		sendPacket.orderChannel = 0
		sendPacket.content = pk.getBuffer()

		return sendPacket
	}

	public async handleConnectedPing(buffer: Buffer): Promise<Frame> {
		const dataPacket = new ConnectedPing(buffer)
		dataPacket.decode()

		const pk = new ConnectedPong()
		pk.clientTimestamp = dataPacket.clientTimestamp
		pk.serverTimestamp = BigInt(Date.now())
		pk.encode()

		const sendPacket = new Frame()
		sendPacket.reliability = FrameReliability.UNRELIABLE
		sendPacket.orderChannel = 0
		sendPacket.content = pk.getBuffer()

		return sendPacket
	}
}
