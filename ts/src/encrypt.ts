import { toBytes, toHex, Hex } from "viem";
import crypto, { KeyObject } from "crypto";

// Player bytecode is prefixed with their address and symmetrically encrypted using a
// player-chosen AES-128 key.
// The AES key is asymmetrically encrypted using the season's public key.

export interface EncryptedCodeSubmission {
    encryptedAesKey: Hex;
    encryptedCode: Hex;
    iv: Hex;
}

export interface SeasonKeys {
    publicKey: Hex;
    privateKey: Hex;
} 

export function createSeasonKeys(): SeasonKeys {
    const k = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    return {
        publicKey: encodeJwk(k.publicKey),
        privateKey: encodeJwk(k.privateKey),
    };
}

export function decryptPlayerCode(
    seasonPrivateKey: Hex,
    playerAddress: Hex,
    submission: EncryptedCodeSubmission,
): Hex {
    const aesKey = crypto.privateDecrypt(
        decodePrivateKey(seasonPrivateKey),
        toBytes(submission.encryptedAesKey),
    );
    if (aesKey.length !== 16) {
        throw new Error(`invalid aes key`);
    }
    const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, toBytes(submission.iv));
    const dec = decipher.update(toBytes(submission.encryptedCode));
    // Code must be prefixed with the player address.
    if (!dec.subarray(0, 20).equals(toBytes(playerAddress))) {
        throw new Error(`invalid code`);
    }
    return toHex(dec.subarray(20));
}

export function encryptPlayerCode(
    seasonPublicKey: Hex,
    playerAddress: Hex,
    plainCode: Hex,
): EncryptedCodeSubmission {
    // Code must be prefixed with the player address.
    const prefixedCode = Buffer.concat([toBytes(playerAddress), toBytes(plainCode)]);
    const aesKey = crypto.generateKeySync('aes', { length: 128 });
    const encryptedAesKey = crypto.publicEncrypt(
        decodePublicKey(seasonPublicKey),
        aesKey.export(),
    );
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, iv);
    const encryptedCode = cipher.update(prefixedCode);
    return {
        encryptedAesKey: toHex(encryptedAesKey),
        encryptedCode: toHex(encryptedCode),
        iv: toHex(iv),
    };
}

export function deriveSeasonPublicKey(seasonPrivateKey: Hex): Hex {
    return encodeJwk(crypto.createPublicKey(decodePrivateKey(seasonPrivateKey)));
}

function decodeJwk(jwk: Hex): crypto.JsonWebKey {
    return JSON.parse(Buffer.from(toBytes(jwk)).toString());
}

function encodeJwk(key: KeyObject): Hex {
    return toHex(Buffer.from(JSON.stringify(key.export({ format: 'jwk' }))));
}

function decodePrivateKey(jwk: Hex): crypto.KeyObject {
    return crypto.createPrivateKey({ key: decodeJwk(jwk), format: 'jwk' });
}

function decodePublicKey(jwk: Hex): crypto.KeyObject {
    return crypto.createPublicKey({ key: decodeJwk(jwk), format: 'jwk' });
}