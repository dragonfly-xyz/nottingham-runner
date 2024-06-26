import crypto from 'crypto';
import { Hex } from 'viem';

export class Prng {
    private seed: Buffer;

    constructor(seed: string | Buffer) {
        this.seed = sha256(seed);
    }
    
    public sample(n: number, r: number): number[] {
        if (r > n) {
            throw new Error(`r (${r}) > n (${n})`);
        }
        if (n === 0) {
            return [];
        }
        return this.sampleWeighted(new Array(n).fill(1), r);
    }

    public sampleWeighted(weights: number[], r: number): number[] {
        const idxs = weights.map((_, i) => i);
        weights = weights.slice();
        const sampledIdxs = [] as number[];
        for (let i = 0; i < r; ++i) {
            const idx = this.pickWeighted(weights);
            sampledIdxs.push(idxs[idx]);
            weights.splice(idx, 1);
            idxs.splice(idx, 1);
        }
        return sampledIdxs;
    }

    public pickWeighted(weights: number[]): number {
        if (weights.length === 0) {
            throw new Error('Empty array to pickWeighted()');
        }
        const accWeights = weights.reduce((acc, w, i) => [...acc, w + (acc[i - 1] ?? 0)], []);
        const total = weights = accWeights[accWeights.length - 1] ?? 0;
        const needle = Math.floor(this.uniformRange(0, total));
        return accWeights.findIndex((s => s >= needle));
    }

    public shuffle<T>(arr: T[]): T[] {
        const idxs = arr.map((_, i) => ({ r: this.uniform(), idx: i })).sort((a, b) => a.r - b.r);
        return idxs.slice().map(r => arr[r.idx]);
    }

    public uniform(): number {
        return this._readUniform(this.advance());
    }

    public uniformRange(min: number, max: number): number {
        return this.uniform() * (max - min) + min;
    }

    public bytes32(): Hex {
        return this._readBytes32(this.advance());
    }

    public advance(): Buffer {
        const old = this.seed;
        this.seed = sha256(this.seed);
        return old;
    }

    private _readUniform(seed: Buffer): number {
        return seed.readUintBE(0, 6) / 2**48;
    }

    private _readBytes32(seed: Buffer): Hex {
        return `0x${seed.toString('hex')}`;
    }
}

function sha256(s: string | Buffer): Buffer {
    const h = crypto.createHash('sha256');
    return h.update(s).digest();
}
