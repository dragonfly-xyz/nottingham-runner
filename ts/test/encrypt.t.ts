import { expect } from 'chai';
import { SeasonKeys,
    createSeasonKeys,
    decryptPlayerCode,
    encryptPlayerCode,
} from '../src/encrypt.js';
import crypto from 'crypto';
import { fromBytes, toHex } from 'viem';


describe('encryption tests', () => {
    const SUBMISSION_CODE_MAX_SIZE = 0x10100;
    const MAX_CODE_SIZE = 0x8000;
    let seasonKeys: SeasonKeys;
    let badSeasonKeys: SeasonKeys;
    const PLAIN_CODE = toHex(crypto.randomBytes(MAX_CODE_SIZE));
    const PLAYER_ADDRESS = fromBytes(crypto.randomBytes(20), 'hex');
    const WRONG_PLAYER_ADDRESS = fromBytes(crypto.randomBytes(20), 'hex');

    before(() => {
        seasonKeys = createSeasonKeys();
        badSeasonKeys = createSeasonKeys();
    });

    it('encrypted bytecode is below submission maximum', () => {
        const sub = encryptPlayerCode(seasonKeys.publicKey, PLAYER_ADDRESS, PLAIN_CODE);
        expect(sub.encryptedCode.length).to.be.lessThan(SUBMISSION_CODE_MAX_SIZE);
    });

    it('can encrypt then decrypt data', () => {
        const sub = encryptPlayerCode(seasonKeys.publicKey, PLAYER_ADDRESS, PLAIN_CODE);
        const code = decryptPlayerCode(seasonKeys.privateKey, PLAYER_ADDRESS, sub);
        expect(code).to.eq(PLAIN_CODE);
    });

    it('decrypt fails with wrong season key', () => {
        const sub = encryptPlayerCode(seasonKeys.publicKey, PLAYER_ADDRESS, PLAIN_CODE);
        expect(() => decryptPlayerCode(badSeasonKeys.privateKey, PLAYER_ADDRESS, sub))
            .to.throw();
    });

    it('decrypt fails with wrong iv', () => {
        const sub = encryptPlayerCode(seasonKeys.publicKey, PLAYER_ADDRESS, PLAIN_CODE);
        expect(() => decryptPlayerCode(
            seasonKeys.privateKey,
            PLAYER_ADDRESS,
            { ...sub, iv: toHex(crypto.randomBytes(12)) }),
        ).to.throw();
    });

    it('decrypt fails with wrong prefix', () => {
        const sub = encryptPlayerCode(seasonKeys.publicKey, PLAYER_ADDRESS, PLAIN_CODE);
        expect(() => decryptPlayerCode(seasonKeys.privateKey, WRONG_PLAYER_ADDRESS, sub))
            .to.throw('invalid code');
    });
});