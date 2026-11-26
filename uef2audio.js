// Read a string from a DataView
const readString = (dataView, offset, length) => String.fromCharCode.apply(null, new Uint8Array(dataView.buffer.slice(dataView.byteOffset + offset, dataView.byteOffset + offset + length)));

// Write a string to a DataView
const writeString = (dataView, string, offset) => { for (let i = 0; i < string.length; ++i) dataView.setUint8(offset + i, string.charCodeAt(i)); };

// Checks if UEF data is a valid UEF file
const isUefFile = dataView => dataView.byteLength >= 12 && readString(dataView, 0, 10) == 'UEF File!\0';

// Reads a single chunk from a UEF file
const readChunk = (dataView, offset) => ({
	id : dataView.getUint16(offset, true),
	data : new DataView(dataView.buffer, offset + 6, dataView.getUint32(offset + 2, true))
});

// Reads all chunks from a UEF file
const readChunks = (dataView, offset) => {
	const chunks = [];
	while (offset < dataView.byteLength) {
		const chunk = readChunk(dataView, offset);
		chunks.push(chunk);
		offset += chunk.data.byteLength + 6;
	}
	return chunks;
};

// Read a complete UEF file
const readUef = dataView => isUefFile(dataView) ? {
	version : { major : dataView.getUint8(11), minor : dataView.getUint8(10) },
	chunks : readChunks(dataView, 12)
} : null;

// Parse and convert raw UEF data into a wave file
const convertUef = arrayBuffer => {

	const data = new DataView(arrayBuffer);
	
	let uef = readUef(data);
	if (!uef) return null;
	
	// Wave file properties
	const sampleRate = 44100;
	const bitsPerSample = 16;
	const channelCount = 1;
	
	const blockAlign = channelCount * bitsPerSample / 8;
	const byteRate = sampleRate * blockAlign;
	
	let samplesByteLength = 0;
	let waveBuffer = null;
	
	// Iterate over the chunks in two passes to generate the wave file
	for (let pass = 0; pass < 2; ++pass) {
		
		// Reset default state
		let baseFrequency = 1200;
		let phase = 180;
		let bitRepeat = 1;
		
		// Access to the wave buffer
		let samples = null;
		
		// If this is the second pass, we know how long to create the wave buffer.
		if (samplesByteLength > 0) {
			
			waveBuffer = new ArrayBuffer(44 + samplesByteLength);
			samples = new Uint8Array(waveBuffer, 44, samplesByteLength);
			
			// Populate the wave header
			const header = new DataView(waveBuffer);
			
			writeString(header, 'RIFF', 0);
			header.setUint32(4, waveBuffer.byteLength, true);
			writeString(header, 'WAVE', 8);
			
			writeString(header, 'fmt ', 12); // Chunk ID
			header.setUint32(16, 16, true); // Chunk size
			header.setUint16(20, 1, true); // Format = PCM
			header.setUint16(22, channelCount, true);
			header.setUint32(24, sampleRate, true);
			header.setUint32(28, byteRate, true);
			header.setUint16(32, blockAlign, true);
			header.setUint16(34, bitsPerSample, true);
			
			writeString(header, 'data', 36); // Chunk ID
			header.setUint32(40, samplesByteLength, true); // Chunk size
			
			// Reset the sample position
			samplesByteLength = 0;
		}
		
		let cyc0, cyc1, bit0, bit1;
		
		const buildWave = (frequency, cycles, offset = 0) => {
			const count = Math.round(sampleRate / frequency * cycles);
			const waveBuffer = new ArrayBuffer(count * blockAlign);
			const waveDataView = new DataView(waveBuffer);
			for (let i = 0; i < count; ++i) {
				let a = (((phase + offset) / 360) + (i * cycles / count)) * (2 * Math.PI);
				let v = Math.floor(Math.sin(a) * 0x7FFF);
				waveDataView.setInt16(i * blockAlign, v, true);
			}
			return new Uint8Array(waveBuffer);
		};
		
		// Build wave samples
		const buildSamples = () => {
			cyc0 = buildWave(baseFrequency, 1);
			cyc1 = buildWave(baseFrequency * 2, 1);
			bit0 = buildWave(baseFrequency, bitRepeat);
			bit1 = buildWave(baseFrequency * 2, bitRepeat * 2);
		};
		buildSamples();
		
		// Write a generated set of wave samples
		const writeWave = wave => {
			if (samples) samples.set(wave, samplesByteLength);
			samplesByteLength += wave.length;
		};
		
		// Write a single bit in the current format
		const writeBit = bit => writeWave(bit ? bit1 : bit0);
		
		// Write a numeric value with a start bit, number of data bits, parity bit and number of stop bits
		const writeValue = (value, bits = 8, parity = 'N', stop = 1) => {
			
			// Parity flag
			let p = (parity == 'O');
			
			// Start bit
			writeBit(0);
			
			// Data bits
			while (bits-- > 0) {
				writeBit(value & 1);
				p ^= value & 1;
				value >>= 1;
			}
			
			// Parity bit
			if (parity != 'N') writeBit(p);
			
			// Stop bits
			if (stop < 0) {
				writeWave(cyc1);
				stop = -stop;
			}
			while (stop-- > 0) writeBit(1);
		};
		
		// Write a series of numeric values each with a start bit, number of data bits, parity bit and number of stop bits
		const writeValues = (values, bits = 8, parity = 'N', stop = 1) => {
			values.forEach(v => writeValue(v, bits, parity, stop));
		};
		
		// Write a block of carrier cycles
		const writeCarrier = cycles => {
			while (cycles-- > 0) {
				writeWave(cyc1);
			}
		};
		
		var title = 'uef2audio';
		
		uef.chunks.forEach(chunk => {
			switch (chunk.id) {
				case 0x0009: {
					// Short title
					title = readString(chunk.data, 0, chunk.data.byteLength);
				} break;
				case 0x0100: {
					// Implicit start/stop bit tape data block
					writeValues(new Uint8Array(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength))
				} break;
				case 0x0102: {
					// Explicit tape data block
					const bitCount = chunk.data.byteLength * 8 - chunk.data.getUint8(0);
					for (let i = 0, value = 0; i < bitCount; ++i) {
						if ((i % 8) == 0) value = chunk.data.getUint8(i / 8 + 1);
						writeBit(value & 1);
						value >>= 1;
					}
				} break;
				case 0x0104: {
					// Defined tape format data block
					writeValues(new Uint8Array(chunk.data.buffer, chunk.data.byteOffset + 3, chunk.data.byteLength - 3), chunk.data.getUint8(0), String.fromCharCode(chunk.data.getUint8(1)), chunk.data.getInt8(2));
				} break;
				case 0x0110: {
					// Carrier tone
					writeCarrier(chunk.data.getUint16(0, true));
				} break;
				case 0x0111: {
					// Carrier tone with dummy byte
					writeCarrier(chunk.data.getUint16(0, true));
					writeValue(0xAA);
					writeCarrier(chunk.data.getUint16(2, true));
				} break;
				case 0x0112: {
					// Integer gap
					samplesByteLength += chunk.data.getUint16(0, true) * cyc1.length;
				} break;
				case 0x0116: {
					// Floating point gap
					samplesByteLength += Math.max(0, blockAlign * Math.round(chunk.data.getFloat32(0, true) * byteRate / blockAlign));
				} break;
				case 0x0113: {
					// Change of base frequency
					const f = chunk.data.getFloat32(0, true);
					if (baseFrequency != f) {
						baseFrequency = f;
						buildSamples();
					}
				} break;
				case 0x0114: {
					// Security cycles
					let numCycles = chunk.data.getUint32(0, true) & 0xFFFFFF;
					
					// Read a single bit
					let i = 0;
					const readBit = () => {
						const result = (chunk.data.getUint8(Math.floor(i / 8) + 5) & (0x01 << (i & 7))) != 0;
						++i; --numCycles;
						return result;
					};
					
					// Do we start with an extra pulse?
					if (String.fromCharCode(chunk.data.getUint8(3)) == 'P') {
						writeWave(buildWave(baseFrequency * (readBit() ? 2 : 1), 0.5, 180));
					}
					
					// Write the main security cycles
					while (numCycles > 1) {
						writeWave(readBit() ? cyc1 : cyc0);
					}
					
					if (numCycles == 1) {
						// Do we end with an extra pulse?
						if (String.fromCharCode(chunk.data.getUint8(4)) == 'P') {
							writeWave(buildWave(baseFrequency * (readBit() ? 2 : 1), 0.5, 0));
						} else {
							writeWave(readBit() ? cyc1 : cyc0);
						}
					}
				} break;
				case 0x0115: {
					// Phase change
					let p = chunk.data.getUint16(0, true);
					if (phase != p) {
						phase = p;
						buildSamples();
					}
				} break;
				case 0x0117: {
					// Data encoding format change
					let b = chunk.data.getUint16(0, true);
					switch (b) {
						case 300:
							if (bitRepeat != 4) {
								bitRepeat = 4;
								buildSamples();
							}
							break;
						case 1200:
							if (bitRepeat != 1) {
								bitRepeat = 1;
								buildSamples();
							}
							break;
						default:
							console.warn('Unsupported data encoding format ' + b);
							break;
					}
				} break;
			}
		});	
	}
	
	// Return the parsed UEF and the wave file
	return {
		uef : uef,
		wave : new File([waveBuffer], title + '.wav', { type: 'audio/wav' })
	};
};

// Process a single audio tag
const processAudioTag = audioTag => {
	// The audio tag must have a single source element and it can't have an audio type
	const sources = audioTag.getElementsByTagName('source');
	if (sources.length == 1 && typeof sources[0].src == 'string' && !/^audio\//.test(sources[0].type)) {
		// Fetch the UEF data with XMLHttpRequest
		const request = new XMLHttpRequest();
		request.open('GET', sources[0].src, true);
    	request.responseType = 'arraybuffer';
    	request.onload = () => {
			if (request.status == 200) {
				// Routine to update the audio tag with the parsed UEF
				const updateAudioTag = uef => {
					audioTag.src = URL.createObjectURL(uef.wave);
					const a = document.createElement('a');
					a.download = uef.wave.name;
					a.href = audioTag.src;
					audioTag.parentNode.appendChild(a);
				};
				const data = new DataView(request.response);
				const uef = convertUef(request.response);
				if (uef) {
					// Plain UEF parsed successfully
					updateAudioTag(uef);
				} else if (data.byteLength > 2 && data.getUint16(0, false) == 0x1F8B) {
					// If we can't decode a plain UEF, it might be gzipped.
					const gzipStream = new DecompressionStream('gzip');
					// Convert the existing resource to a readable stream.
					const sourceStream = new ReadableStream({
						pull : controller => {
							controller.enqueue(request.response);
							controller.close();
						}
					});
					// Pipe the readable source through the gzip decompression stream to extract the source data and try to parse that as UEF
					new Response(sourceStream.pipeThrough(gzipStream)).arrayBuffer().then(data => {
						const uef = convertUef(data);
						if (uef) updateAudioTag(uef);
					});
				}
			}
		};
		request.send(null);
    }
};

// Process all audio tags on the page
window.addEventListener('DOMContentLoaded', () => {
    [...document.getElementsByTagName('audio')].forEach(processAudioTag);
});