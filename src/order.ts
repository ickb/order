import { ccc } from "@ckb-ccc/core";
import type { SmartTransaction, UdtHandler } from "@ickb/dao";
import { Data, Info, Relative, type Ratio } from "./entities.js";
import { OrderCell, OrderGroup } from "./cells.js";

export class Order {
  constructor(
    public script: ccc.Script,
    public cellDeps: ccc.CellDep[],
    public udtHandler: UdtHandler,
  ) {}

  isOrder(cell: ccc.Cell): boolean {
    return (
      cell.cellOutput.lock.eq(this.script) &&
      Boolean(cell.cellOutput.type?.eq(this.udtHandler.script))
    );
  }

  isMaster(cell: ccc.Cell): boolean {
    return Boolean(cell.cellOutput.type?.eq(this.script));
  }

  mint(
    tx: SmartTransaction,
    lock: ccc.Script,
    info: Info,
    ckbAmount: ccc.FixedPoint, //it will use way more CKB than expressed in ckbAmount
    udtAmount: ccc.FixedPoint,
  ): void {
    const data = Data.from({
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

  matchCkb2Udt(
    tx: SmartTransaction,
    order: OrderCell,
    udtAllowance: ccc.FixedPoint,
  ): void {
    this.match(tx, order, true, udtAllowance);
  }

  matchUdt2Ckb(
    tx: SmartTransaction,
    order: OrderCell,
    ckbAllowance: ccc.FixedPoint,
  ): void {
    this.match(tx, order, false, ckbAllowance);
  }

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
        Data.from({
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
    const feeRate = options?.minCkbGain ?? ccc.Zero;
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
    if (ckbMinGain <= -best.cost - txClone.estimateFee(feeRate)) {
      tx.copy(txClone);
    }
  }

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

interface Partial {
  ckbDelta: bigint;
  udtDelta: bigint;
  matches: {
    order: OrderCell;
    ckbOut: ccc.FixedPoint;
    udtOut: ccc.FixedPoint;
  }[];
}

class Buffered<T> {
  public buffer: T[] = [];

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
