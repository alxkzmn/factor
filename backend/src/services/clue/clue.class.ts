import { Service, MemoryServiceOptions } from "feathers-memory";
import { Application } from "../../declarations";
import { Params } from "@feathersjs/feathers";
import { plonk } from "snarkjs";
import { solution, solutionIndex } from "../../utils/words";
import { asAsciiArray } from "../../utils/asAsciiArray";
import { buildPoseidon } from "circomlibjs";
import { BigNumber } from "ethers";
import { ethers } from "ethers";
import latestTestnetDeployment from "../../blockchain_cache/ZKWordle.s.sol/31337/run-latest.json";
import contractAbi from "../../blockchain_cache/ZKWordle.sol/ZKWordle.json";

const CIRCUIT_WASM_PATH = "src/zk/wordle.wasm";
const CIRCUIT_ZKEY_PATH = "src/zk/wordle_final.zkey";

interface Guess {
  guess: number[];
}

export interface BlockchainOptions {
  provider: ethers.providers.Provider;
  minterPrivateKey: string;
  chainId: string;
}

export interface ClueServiceOptions extends MemoryServiceOptions {
  blockchainOptions: BlockchainOptions;
}

export class Clue extends Service {
  wallet: ethers.Wallet | undefined;
  zkWordleContract: ethers.Contract | undefined;
  private randomSalt: number | undefined;

  //eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(options: Partial<ClueServiceOptions>, app: Application) {
    super(options);
    this.randomSalt = Math.random() * 1e18;
    if (!options?.blockchainOptions?.minterPrivateKey) {
      throw new Error("Private key cannot be empty");
    } else if (!options.blockchainOptions.chainId) {
      throw new Error("chainId cannot be empty");
    } else {
      this.wallet = new ethers.Wallet(
        options.blockchainOptions.minterPrivateKey ?? "",
        options.blockchainOptions.provider
      );
      let contractDeploymenTransaction =
        latestTestnetDeployment.transactions[0];
      this.zkWordleContract = new ethers.Contract(
        contractDeploymenTransaction.contractAddress,
        contractAbi.abi,
        this.wallet
      );
    }
  }

  async create(data: Guess, params?: Params) {
    const { guess } = data;
    console.log("Received guess:", guess);
    console.log("Solution:", solution);
    console.log("Solution index:", solutionIndex);

    //Poseidon hash is a BigInt
    let solutionCommitment = BigNumber.from(
      await this.zkWordleContract!.solutionCommitment(solutionIndex)
    );
    let asciiSolution = asAsciiArray(solution);
    //If the mapping in a smart contract returns zero, it means that either the day has changed and the solution index is different,
    //or the game hasn't yet started
    if (solutionCommitment.isZero()) {
      console.log("Solution commitment not found, creating...");
      //Creating new salt for the new solution
      this.randomSalt = Math.random() * 1e18;

      let poseidon = await buildPoseidon();
      let solutionAsNum = 0;
      for (let i = 0; i < asciiSolution.length; i++) {
        solutionAsNum += asciiSolution[i] * Math.pow(100, i);
      }
      const hashed = BigNumber.from(
        poseidon.F.toObject(poseidon([solutionAsNum, this.randomSalt]))
      );
      console.log("Commitment: " + hashed);
      const tx = await this.zkWordleContract!.commitSolution(
        solutionIndex,
        hashed
      );
      const receipt = await tx.wait();
      console.log(receipt);
    } else {
      console.log("Solution commitment found: ", solutionCommitment.toString());
    }
    let proof = await plonk.fullProve(
      {
        solution: asciiSolution,
        salt: this.randomSalt,
        guess: guess,
      },
      CIRCUIT_WASM_PATH,
      CIRCUIT_ZKEY_PATH
    );
    console.log(`Proof generated`);
    console.log(proof);

    let response = {
      proof: proof.publicSignals.slice(0, 5),
      hash: proof.publicSignals[5],
    };
    return super.create(response, params);
  }
}
