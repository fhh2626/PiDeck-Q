/** Incremental length-prefix decoding with one bounded payload allocation per frame. */
export class HostFrameDecoder {
	private readonly header = Buffer.alloc(4);
	private headerOffset = 0;
	private payload: Buffer | null = null;
	private payloadOffset = 0;

	private readonly maxFrameBytes: number;

	constructor(maxFrameBytes: number) { this.maxFrameBytes = maxFrameBytes; }

	/** Release partial payloads when the owning connection closes. */
	reset(): void {
		this.headerOffset = 0;
		this.payload = null;
		this.payloadOffset = 0;
	}

	/** A false callback stops parsing immediately, e.g. after invalid JSON or failed hello. */
	push(chunk: Buffer, onFrame: (payload: Buffer) => boolean, onOversized: () => void): void {
		let offset = 0;
		while (offset < chunk.length) {
			if (!this.payload) {
				const length = Math.min(4 - this.headerOffset, chunk.length - offset);
				this.header.set(chunk.subarray(offset, offset + length), this.headerOffset);
				this.headerOffset += length;
				offset += length;
				if (this.headerOffset < 4) return;
				const frameLength = this.header.readUInt32LE(0);
				this.headerOffset = 0;
				// Reject the declared length before allocating; header-only attacks stay small.
				if (frameLength > this.maxFrameBytes) {
					this.reset();
					onOversized();
					return;
				}
				this.payload = Buffer.allocUnsafe(frameLength);
			}
			const payload = this.payload;
			const length = Math.min(payload.length - this.payloadOffset, chunk.length - offset);
			payload.set(chunk.subarray(offset, offset + length), this.payloadOffset);
			this.payloadOffset += length;
			offset += length;
			if (this.payloadOffset < payload.length) return;
			// Clear ownership before calling out: close/reentrant listeners must not retain it.
			this.payload = null;
			this.payloadOffset = 0;
			if (!onFrame(payload)) { this.reset(); return; }
		}
	}
}
