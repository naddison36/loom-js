import test from 'tape'
import BN from 'bn.js'
import { ethers } from 'ethers'
import ecc from 'eosjs-ecc'

import {
  NonceTxMiddleware,
  CachedNonceTxMiddleware,
  SignedEthTxMiddleware,
  CryptoUtils,
  Client
} from '../../index'
import { LoomProvider } from '../../loom-provider'
import { deployContract } from '../evm-helpers'
import { Address, LocalAddress } from '../../address'
import { createDefaultTxMiddleware, eosAddressToEthAddress } from '../../helpers'
import {
  EthersSigner,
  getJsonRPCSignerAsync,
  OfflineScatterEosSign
} from '../../sign-helpers'
import { createTestHttpClient } from '../helpers'
import { AddressMapper, Coin } from '../../contracts'
import { SignedEosTxMiddleware } from '../../middleware/signed-eos-tx-middleware'

// import Web3 from 'web3'
const Web3 = require('web3')

/**
 * Requires the SimpleStore solidity contract deployed on a loomchain.
 * go-loom/examples/plugins/evmexample/contract/SimpleStore.sol
 *
 * pragma solidity ^0.4.24;
 *
 * contract SimpleStore {
 *   uint256 value;
 *
 *   constructor() public {
 *       value = 10;
 *   }
 *
 *   event NewValueSet(uint indexed _value, address sender);
 *
 *   function set(uint _value) public {
 *     value = _value;
 *     emit NewValueSet(value, msg.sender);
 *   }
 *
 *   function get() public view returns (uint) {
 *     return value;
 *   }
 * }
 *
 */

const toCoinE18 = (amount: number): BN => {
  return new BN(10).pow(new BN(18)).mul(new BN(amount))
}

const eosKeys = async () => {
  const eosPrivateKey = await ecc.randomKey()
  const eosAddress = ecc.privateToPublic(eosPrivateKey)
  return { eosPrivateKey, eosAddress }
}

async function bootstrapTest(
  createClient: () => Client
): Promise<{
  client: Client
  pubKey: Uint8Array
  privKey: Uint8Array
  loomProvider: LoomProvider
  contract: any
  // ABI: any[]
}> {
  // Create the client
  const privKey = CryptoUtils.B64ToUint8Array(
    'D6XCGyCcDZ5TE22h66AlU+Bn6JqL4RnSl4a09RGU9LfM53JFG/T5GAnC0uiuIIiw9Dl0TwEAmdGb+WE0Bochkg=='
  )
  const pubKey = CryptoUtils.publicKeyFromPrivateKey(privKey)
  const client = createClient()
  client.on('error', err => console.error(err))
  client.txMiddleware = createDefaultTxMiddleware(client, privKey)

  // Create LoomProvider instance
  const loomProvider = new LoomProvider(client, privKey)

  // Contract data and ABI
  const contractData =
    '608060405234801561001057600080fd5b50600a60008190555061014e806100286000396000f30060806040526004361061004c576000357c0100000000000000000000000000000000000000000000000000000000900463ffffffff16806360fe47b1146100515780636d4ce63c1461007e575b600080fd5b34801561005d57600080fd5b5061007c600480360381019080803590602001909291905050506100a9565b005b34801561008a57600080fd5b50610093610119565b6040518082815260200191505060405180910390f35b806000819055506000547f7e0b7a35f017ec94e71d7012fe8fa8011f1dab6090674f92de08f8092ab30dda33604051808273ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200191505060405180910390a250565b600080549050905600a165627a7a7230582041f33d6a8b78928e192affcb980ca6bef9b6f5b7da5aa4b2d75b1208720caeeb0029'

  const ABI = [
    {
      constant: false,
      inputs: [
        {
          name: '_value',
          type: 'uint256'
        }
      ],
      name: 'set',
      outputs: [],
      payable: false,
      stateMutability: 'nonpayable',
      type: 'function'
    },
    {
      constant: true,
      inputs: [],
      name: 'get',
      outputs: [
        {
          name: '',
          type: 'uint256'
        }
      ],
      payable: false,
      stateMutability: 'view',
      type: 'function'
    },
    {
      inputs: [],
      payable: false,
      stateMutability: 'nonpayable',
      type: 'constructor'
    },
    {
      anonymous: false,
      inputs: [
        {
          indexed: true,
          name: '_value',
          type: 'uint256'
        },
        {
          indexed: false,
          name: 'sender',
          type: 'address'
        }
      ],
      name: 'NewValueSet',
      type: 'event'
    }
  ]

  // Deploy the contract using loom provider
  const result = await deployContract(loomProvider, contractData)

  // Instantiate Contract using web3
  const web3 = new Web3(loomProvider)
  const contract = new web3.eth.Contract(ABI, result.contractAddress, {
    from: LocalAddress.fromPublicKey(pubKey).toString()
  })

  return { client, contract, loomProvider, pubKey, privKey }
}

test('Test Signed Eth Tx Middleware Type 1', async t => {
  t.timeoutAfter(1000 * 60 * 10)
  try {
    const { client, loomProvider, contract } = await bootstrapTest(createTestHttpClient)

    // Get address of the account 0 = 0x90f8bf6a479f320ead074411a4b0e7944ea8c9c1
    const { eosPrivateKey, eosAddress } = await eosKeys()
    const offlineScatterSigner = new OfflineScatterEosSign(eosPrivateKey)
    const callerChainId = 'eos'
    const ethAddress = eosAddressToEthAddress(eosAddress).toLowerCase()

    // Override the default caller chain ID
    loomProvider.callerChainId = callerChainId
    // Ethereum account needs its own middleware
    loomProvider.setMiddlewaresForAddress(ethAddress, [
      new NonceTxMiddleware(
        new Address(callerChainId, LocalAddress.fromHexString(ethAddress)),
        client
      ),
      new SignedEosTxMiddleware(offlineScatterSigner, ethAddress)
    ])

    const middlewaresUsed = loomProvider.accountMiddlewares.get(ethAddress)
    t.assert(middlewaresUsed![0] instanceof NonceTxMiddleware, 'NonceTxMiddleware used')
    t.assert(middlewaresUsed![1] instanceof SignedEosTxMiddleware, 'SignedEosTxMiddleware used')

    let tx = await contract.methods.set(1).send({ from: ethAddress })
    t.equal(
      tx.status,
      '0x1',
      `SimpleStore.set should return correct status for address (to) ${ethAddress}`
    )

    t.equal(
      tx.events.NewValueSet.returnValues.sender.toLowerCase(),
      ethAddress,
      `Sender should be same sender from eth ${ethAddress}`
    )
  } catch (err) {
    console.error(err)
    t.fail(err.message)
  }

  t.end()
})
