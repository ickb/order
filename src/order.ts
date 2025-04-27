import { ccc } from "@ckb-ccc/core";
import type { ScriptDeps, SmartTransaction, UdtHandler } from "@ickb/utils";
import { OrderData, Info, Relative, type Ratio } from "./entities.js";
import { OrderCell, OrderGroup } from "./cells.js";

/**
 * Utilities for managing UDT orders on Nervos L1 such as minting, matching, and melting.
 */
export class OrderManager implements ScriptDeps {
  /**
   * Creates an instance of OrderManager.
   * @param script - The order script.
   * @param cellDeps - The cell dependencies for the order.
   * @param udtHandler - The handler for UDT (User Defined Token).
   */
  constructor(
    public script: ccc.Script,
    public cellDeps: ccc.CellDep[],
    public udtHandler: UdtHandler,
  ) {}

  /**
   * Returns a new instance of OrderManager.
   *
   * @returns A new instance of OrderManager.
   */
  static fromDeps(c: ScriptDeps, udtHandler: UdtHandler): OrderManager {
    return new OrderManager(c.script, c.cellDeps, udtHandler);
  }

  /**
   * Checks if the given cell is an order.
   * @param cell - The cell to check.
   * @returns True if the cell is an order, otherwise false.
   */
  isOrder(cell: ccc.Cell): boolean {
    return (
      cell.cellOutput.lock.eq(this.script) &&
      Boolean(cell.cellOutput.type?.eq(this.udtHandler.script))
    );
  }

  /**
   * Checks if the given cell is a master cell.
   * @param cell - The cell to check.
   * @returns True if the cell is a master, otherwise false.
   */
  isMaster(cell: ccc.Cell): boolean {
    return Boolean(cell.cellOutput.type?.eq(this.script));
  }

  /**
   * Mints a new order cell and appends it to the transaction.
   * @param tx - The transaction to which the order will be added.
   * @param lock - The lock script for the master cell.
   * @param info - The information related to the order.
   * @param ckbAmount - The amount of CKB to allocate for the order.
   * @param udtAmount - The amount of UDT to allocate for the order.
   */
  mint(
    tx: SmartTransaction,
    lock: ccc.Script,
    info: Info,
    ckbAmount: ccc.FixedPoint, // it will use way more CKB than expressed in ckbAmount
    udtAmount: ccc.FixedPoint,
  ): void {
    const data = OrderData.from({
      udtAmount,
      master: {
        type: "relative",
        value: Relative.create(1n), // master is appended right after its order
      },
      info,
    });

    data.validate();

    tx.addCellDeps(this.cellDeps);
    tx.addUdtHandlers(this.udtHandler);

    // Append order cell to Outputs
    const position = tx.addOutput(
      {
        lock: this.script,
        type: this.udtHandler.script,
      },
      data.toBytes(),
    );
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    tx.outputs[position]!.capacity += ckbAmount;

    // Append master cell to Outputs right after its order
    tx.addOutput({
      lock,
      type: this.script,
    });
  }

  /**
   * Matches a CKB to UDT order.
   * @param tx - The transaction to which the match will be added.
   * @param order - The order cell to match against.
   * @param udtAllowance - The allowance for UDT.
   */
  matchCkb2Udt(
    tx: SmartTransaction,
    order: OrderCell,
    udtAllowance: ccc.FixedPoint,
  ): void {
    this.match(tx, order, true, udtAllowance);
  }

  /**
   * Matches a UDT to CKB order.
   * @param tx - The transaction to which the match will be added.
   * @param order - The order cell to match against.
   * @param ckbAllowance - The allowance for CKB.
   */
  matchUdt2Ckb(
    tx: SmartTransaction,
    order: OrderCell,
    ckbAllowance: ccc.FixedPoint,
  ): void {
    this.match(tx, order, false, ckbAllowance);
  }

  /**
   * Matches the order with the specified parameters.
   * @param tx - The transaction to which the match will be added.
   * @param order - The order cell to match against.
   * @param isCkb2Udt - Indicates if the match is in the CKB to UDT direction or vice versa.
   * @param allowance - The allowance for matching.
   * @throws Will throw an error if the order is incompatible.
   */
  private match(
    tx: SmartTransaction,
    order: OrderCell,
    isCkb2Udt: boolean,
    allowance: ccc.FixedPoint,
  ): void {
    if (!this.isOrder(order.cell)) {
      throw Error("Match impossible with incompatible cell");
    }

    for (const { ckbOut, udtOut } of order.match(isCkb2Udt, allowance)) {
      // Return at the first match
      this.rawMatch(tx, [{ order, ckbOut, udtOut }]);
      return;
    }

    throw Error("Unable to match order");
  }

  /**
   * Processes the raw match results and adds them to the transaction.
   * @param tx - The transaction to which the matches will be added.
   * @param matches - The matches to process.
   */
  private rawMatch(tx: SmartTransaction, matches: Partial["matches"]): void {
    tx.addCellDeps(this.cellDeps);
    tx.addUdtHandlers(this.udtHandler);

    for (const { order, ckbOut, udtOut } of matches) {
      tx.addInput(order.cell);
      tx.addOutput(
        {
          lock: this.script,
          type: this.udtHandler.script,
          capacity: ckbOut,
        },
        OrderData.from({
          udtAmount: udtOut,
          master: {
            type: "absolute",
            value: order.getMaster(),
          },
          info: order.data.info,
        }).toBytes(),
      );
    }
  }

  /**
   * Finds the best match for the given orders based on the current rate.
   * @param tx - The transaction to which the best match will be added.
   * @param orders - The list of order cells to consider for matching.
   * @param currentRate - The current exchange rate between CKB and UDT.
   * @param options - Optional parameters for matching.
   */
  bestMatch(
    tx: SmartTransaction,
    orders: OrderCell[],
    currentRate: Ratio,
    options?: {
      minCkbGain?: ccc.FixedPoint;
      feeRate?: number;
      ckbAllowanceStep?: ccc.FixedPoint;
    },
  ): void {
    const { ckbScale, udtScale } = currentRate;
    const ckbMinGain = options?.minCkbGain ?? ccc.Zero;
    const feeRate = options?.feeRate ?? 1000; // Base fee rate
    const ckbAllowanceStep =
      options?.ckbAllowanceStep ?? ccc.fixedPointFrom(1000); // 1000 CKB
    const udtAllowanceStep =
      (ckbAllowanceStep * ckbScale + udtScale - 1n) / udtScale;

    const ckb2UdtPartials = new Buffered(
      this.partials(orders, true, ckbAllowanceStep),
      2,
    );
    const udt2CkbPartials = new Buffered(
      this.partials(orders, false, udtAllowanceStep),
      2,
    );

    let best = {
      i: -1,
      j: -1,
      cost: 1n << 256n,
      matches: [] as Partial["matches"],
    };
    while (best.i !== 0 && best.j !== 0) {
      ckb2UdtPartials.next(best.i);
      udt2CkbPartials.next(best.j);
      best.i = 0;
      best.j = 0;

      for (const [i, c2u] of ckb2UdtPartials.buffer.entries()) {
        for (const [j, u2c] of udt2CkbPartials.buffer.entries()) {
          const curr = {
            i,
            j,
            cost:
              (c2u.ckbDelta + u2c.ckbDelta) * ckbScale +
              (c2u.udtDelta + u2c.udtDelta) * udtScale,
            matches: c2u.matches.concat(u2c.matches),
          };
          if (curr.cost < best.cost) {
            best = curr;
          }
        }
      }
    }

    if (best.matches.length === 0) {
      return;
    }

    const txClone = tx.clone();
    this.rawMatch(txClone, best.matches);
    if (-best.cost >= (ckbMinGain + txClone.estimateFee(feeRate)) * ckbScale) {
      tx.copy(txClone);
    }
  }

  /**
   * Generates partial match results for the given orders.
   * @param orders - The list of order cells to consider for matching.
   * @param isCkb2Udt - Indicates if the match is in the CKB to UDT direction or vice versa.
   * @param allowanceStep - The allowance for matching.
   * @returns A generator yielding partial match results.
   */
  *partials(
    orders: OrderCell[],
    isCkb2Udt: boolean,
    allowanceStep: ccc.FixedPoint,
  ): Generator<Partial, void, void> {
    orders = [...orders];
    orders = isCkb2Udt
      ? orders.sort((a, b) => a.data.info.ckb2UdtCompare(b.data.info))
      : orders.sort((a, b) => a.data.info.udt2CkbCompare(b.data.info));

    let acc: Partial = {
      ckbDelta: ccc.Zero,
      udtDelta: ccc.Zero,
      matches: [],
    };

    let curr = acc;
    yield curr;

    for (const order of orders) {
      for (const m of order.match(isCkb2Udt, allowanceStep)) {
        curr = {
          ckbDelta: acc.ckbDelta + m.ckbDelta,
          udtDelta: acc.udtDelta + m.udtDelta,
          matches: acc.matches.concat({
            order,
            ckbOut: m.ckbOut,
            udtOut: m.udtOut,
          }),
        };

        yield curr;
      }

      acc = curr;
    }
  }

  /**
   * Melts the specified order group, removing it from the transaction.
   * @param tx - The transaction to which the group will be added.
   * @param group - The order group to melt.
   * @throws Will throw an error if the order is incompatible.
   */
  melt(tx: SmartTransaction, group: OrderGroup): void {
    if (!this.isOrder(group.order.cell)) {
      throw Error("Melt impossible with incompatible cell");
    }

    group.validate();

    tx.addCellDeps(this.cellDeps);
    tx.addUdtHandlers(this.udtHandler);

    tx.addInput(group.order.cell);
    tx.addInput(group.master);
  }

  /**
   * Finds orders associated with the current order instance.
   * @param client - The client used to interact with the blockchain.
   * @returns A promise that resolves to an array of OrderGroup instances.
   */
  async findOrders(client: ccc.Client): Promise<OrderGroup[]> {
    const [simpleOrders, allMasters] = await Promise.all([
      this.findSimpleOrders(client),
      this.findAllMasters(client),
    ]);

    const rawGroups = new Map(
      allMasters.map((c) => [
        c.outPoint.toBytes().toString(),
        {
          master: c,
          origin: undefined as Promise<OrderCell | undefined> | undefined,
          orders: [] as OrderCell[],
        },
      ]),
    );

    for (const order of simpleOrders) {
      const master = order.getMaster();
      const key = master.toBytes().toString();
      const rawGroup = rawGroups.get(key);
      if (!rawGroup) {
        continue;
      }
      rawGroup.orders.push(order);
      if (rawGroup.origin) {
        continue;
      }
      rawGroup.origin = this.findOrigin(client, master);
    }

    const result: OrderGroup[] = [];
    for (const {
      master,
      origin: originPromise,
      orders,
    } of rawGroups.values()) {
      if (orders.length === 0 || !originPromise) {
        continue;
      }
      const origin = await originPromise;
      if (!origin) {
        continue;
      }
      const order = origin.resolve(orders);
      if (!order) {
        continue;
      }

      const orderGroup = OrderGroup.tryFrom(master, order, origin);
      if (!orderGroup) {
        continue;
      }

      result.push(orderGroup);
    }

    return result;
  }

  /**
   * Finds simple orders on the blockchain.
   * @param client - The client used to interact with the blockchain.
   * @returns A promise that resolves to an array of OrderCell instances.
   */
  private async findSimpleOrders(client: ccc.Client): Promise<OrderCell[]> {
    const orders: OrderCell[] = [];
    for await (const cell of client.findCellsOnChain(
      {
        script: this.script,
        scriptType: "lock",
        filter: {
          script: this.udtHandler.script,
        },
        scriptSearchMode: "exact",
        withData: true,
      },
      "asc",
      400, // https://github.com/nervosnetwork/ckb/pull/4576
    )) {
      const order = OrderCell.tryFrom(cell);
      if (!order || !this.isOrder(cell)) {
        continue;
      }
      orders.push(order);
    }
    return orders;
  }

  /**
   * Finds all master cells on the blockchain.
   * @param client - The client used to interact with the blockchain.
   * @returns A promise that resolves to an array of master cells.
   */
  private async findAllMasters(client: ccc.Client): Promise<ccc.Cell[]> {
    const masters: ccc.Cell[] = [];
    for await (const cell of client.findCellsOnChain(
      {
        script: this.script,
        scriptType: "type",
        scriptSearchMode: "exact",
        withData: true,
      },
      "asc",
      400, // https://github.com/nervosnetwork/ckb/pull/4576
    )) {
      if (!this.isMaster(cell)) {
        continue;
      }
      masters.push(cell);
    }
    return masters;
  }

  /**
   * Finds the origin order associated with a given master out point.
   * @param client - The client used to interact with the blockchain.
   * @param master - The master out point to find the origin for.
   * @returns A promise that resolves to the origin OrderCell or undefined if not found.
   */
  private async findOrigin(
    client: ccc.Client,
    master: ccc.OutPoint,
  ): Promise<OrderCell | undefined> {
    const { txHash, index: mIndex } = master;
    for (let index = mIndex - 1n; index >= ccc.Zero; index--) {
      const cell = await client.getCell({ txHash, index });
      if (!cell) {
        return;
      }

      const order = OrderCell.tryFrom(cell);
      if (order?.getMaster().eq(master)) {
        return order;
      }
    }

    // eslint-disable-next-line no-constant-condition, @typescript-eslint/no-unnecessary-condition
    for (let index = mIndex + 1n; true; index++) {
      const cell = await client.getCell({ txHash, index });
      if (!cell) {
        return;
      }

      const order = OrderCell.tryFrom(cell);
      if (order?.getMaster().eq(master)) {
        return order;
      }
    }
  }
}

/**
 * Represents a partial match result for an order.
 */
interface Partial {
  ckbDelta: bigint; // The change in CKB for the match.
  udtDelta: bigint; // The change in UDT for the match.
  matches: {
    order: OrderCell; // The order cell involved in the match.
    ckbOut: ccc.FixedPoint; // The output amount of CKB.
    udtOut: ccc.FixedPoint; // The output amount of UDT.
  }[];
}

/**
 * A buffered generator that tries to maintain a fixed-size buffer of values.
 */
class Buffered<T> {
  public buffer: T[] = [];

  /**
   * Creates an instance of Buffered.
   * @param generator - The generator to buffer values from.
   * @param maxSize - The maximum size of the buffer.
   */
  constructor(
    public generator: Generator<T, void, void>,
    public maxSize: number,
  ) {
    // Try to populate the buffer
    for (const value of generator) {
      this.buffer.push(value);
      if (this.buffer.length >= this.maxSize) {
        break;
      }
    }
  }

  /**
   * Advances the buffer by the specified number of steps.
   * @param n - The number of steps to advance the buffer.
   */
  public next(n: number): void {
    for (let i = 0; i < n; i++) {
      this.buffer.shift();
      const { value, done } = this.generator.next();
      if (!done) {
        this.buffer.push(value);
      }
    }
  }
}
