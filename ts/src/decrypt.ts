import { Hex, toBytes, toHex } from "viem";
import crypto from "crypto";
import { secp256k1 } from "@noble/curves/secp256k1";

export class Decrypter {
    private _decryptKey: crypto.KeyObject;

    public constructor(privateKey: Hex) {
        const privBuf = Buffer.from(toBytes(privateKey));
        if (privBuf.length !== 32) {
            throw new Error(`Invalid private key`);
        }
        const pubBuf = secp256k1.getPublicKey(privateKey, false);
        const jwk = {
            kty: 'EC',
            crv: 'secp256k1',
            d: privBuf.toString('base64'),
            x: Buffer.from(pubBuf.slice(1, 33)).toString('base64'),
            y: Buffer.from(pubBuf.slice(33)).toString('base64'),
        };
        this._decryptKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
    }

    public decrypt(encrypted: Hex): Hex {
        return toHex(
            crypto.privateDecrypt(this._decryptKey, Buffer.from(toBytes(encrypted))),
        );
    }
}