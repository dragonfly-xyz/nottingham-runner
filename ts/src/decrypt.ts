import { Hex, fromHex, keccak256, toBytes, toHex } from "viem";
import crypto from "crypto";
import { secp256k1 } from "@noble/curves/secp256k1";

// Player bytecode is encrypted using public key encryption with a per-user secp256k1 secret:
// S = keccak(seasonPrivateKey + playerAddress) % SECP256K1_N

const SECP256K1_N = 115792089237316195423570985008687907852837564279074904382605163141518161494337n;

export function decryptPlayerCode(decryptKey: Hex, encryptedCode: Hex): Hex {
    return toHex(decryptBytes(toBytes(decryptKey), toBytes(encryptedCode)));
}

export function encryptPlayerCode(encryptKey: Hex, plainCode: Hex): Hex {
    return toHex(encryptBytes(toBytes(encryptKey), toBytes(plainCode)));
}

export function derivePlayerCodeDecryptKey(seasonPrivateKey: Hex, playerAddress: Hex): Hex {
    return toHex(derivePlayerCodeSecretBytes(toBytes(seasonPrivateKey), toBytes(playerAddress)));
}

export function derivePlayerCodeEncryptKey(seasonPrivateKey: Hex, playerAddress: Hex): Hex {
    return toHex(derivePlayerCodePubBytes(toBytes(seasonPrivateKey), toBytes(playerAddress)));
}

function decryptBytes(secret: Uint8Array, encryptedBytes: Uint8Array): Uint8Array {
    return crypto.privateDecrypt(createKeyObject(secret, 'private'), encryptedBytes);
}

function encryptBytes(pub: Uint8Array, plainBytes: Uint8Array): Uint8Array {
    return crypto.publicEncrypt(createKeyObject(pub, 'public'), plainBytes);
}

function derivePlayerCodeSecretBytes(
    seasonPrivateKey: Uint8Array,
    playerAddress: Uint8Array,
): Uint8Array {
    return toBytes(
        fromHex(keccak256(Buffer.concat([seasonPrivateKey, playerAddress])), 'bigint')
            % SECP256K1_N,
        { size: 32 },
    );
}

function derivePlayerCodePubBytes(
    seasonPrivateKey: Uint8Array,
    playerAddress: Uint8Array,
): Uint8Array {
    return secp256k1.getPublicKey(
        derivePlayerCodeSecretBytes(seasonPrivateKey, playerAddress),
        false,
    );
}

function createKeyObject(k: Uint8Array, pair: 'public' | 'private'): crypto.KeyObject {
    const pub = pair === 'private'
        ? secp256k1.getPublicKey(k, false)
        : k;
    const jwk = {
        kty: 'EC',
        crv: 'secp256k1',
        d: Buffer.from(k).toString('base64'),
        x: Buffer.from(pub.slice(1, 33)).toString('base64'),
        y: Buffer.from(pub.slice(33)).toString('base64'),
    };
    return pair === 'public'
        ? crypto.createPublicKey({ key: jwk, format: 'jwk' })
        : crypto.createPrivateKey({ key: jwk, format: 'jwk' });
}
