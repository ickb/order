import { ccc } from "@ckb-ccc/core";
import type { SmartTransaction, UdtHandler } from "@ickb/dao";
import { Data, Info, Relative } from "./entities.js";
import { OrderCell, OrderGroup, type Match } from "./cells.js";

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
    o: OrderCell,
    udtAllowance: ccc.FixedPoint,
  ): void {
    this.match(tx, o, true, udtAllowance);
  }

  matchUdt2Ckb(
    tx: SmartTransaction,
    o: OrderCell,
    ckbAllowance: ccc.FixedPoint,
  ): void {
    this.match(tx, o, false, ckbAllowance);
  }

  private match(
    tx: SmartTransaction,
    o: OrderCell,
    isCkb2Udt: boolean,
    allowance: ccc.FixedPoint,
  ): void {
    if (!this.isOrder(o.cell)) {
      throw Error("Match impossible with incompatible cell");
    }

    const { ckbOut, udtOut } = isCkb2Udt
      ? o.matchCkb2Udt(allowance)
      : o.matchUdt2Ckb(allowance);

    tx.addCellDeps(this.cellDeps);
    tx.addUdtHandlers(this.udtHandler);

    tx.addInput(o.cell);
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
          value: o.getMaster(),
        },
        info: o.data.info,
      }).toBytes(),
    );
  }

  partials(
    orders: OrderCell[],
    isCkb2Udt: boolean,
    step: ccc.FixedPoint,
  ): {
    in: OrderCell;
    out: Match & {
      ckbGain: bigint;
      udtGain: bigint;
    };
  }[][] {
    const allPartials: {
      in: OrderCell;
      out: Match & {
        ckbGain: bigint;
        udtGain: bigint;
      };
    }[][] = [];

    orders = isCkb2Udt
      ? [...orders].sort((a, b) => a.data.info.ckb2UdtCompare(b.data.info))
      : [...orders].sort((a, b) => a.data.info.udt2CkbCompare(b.data.info));

    for (const order of orders) {
      const { ckbIn, udtIn } = order.getAmounts();
      const partials = (
        isCkb2Udt ? order.partialsCkb2Udt(step) : order.partialsUdt2Ckb(step)
      ).map((match) => ({
        in: order,
        out: {
          ...match,
          ckbGain: ckbIn - match.ckbOut,
          udtGain: udtIn - match.udtOut,
        },
      }));

      const first = partials[0];
      if (
        !first ||
        (isCkb2Udt ? -first.out.udtGain : -first.out.ckbGain) > step // Minimal fulfillment is too big
      ) {
        continue;
      }

      allPartials.push(partials);
    }

    return allPartials;
  }

  melt(tx: SmartTransaction, og: OrderGroup): void {
    if (!this.isOrder(og.order.cell)) {
      throw Error("Melt impossible with incompatible cell");
    }

    og.validate();

    tx.addCellDeps(this.cellDeps);
    tx.addUdtHandlers(this.udtHandler);

    tx.addInput(og.order.cell);
    tx.addInput(og.master);
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
