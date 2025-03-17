import { ccc, type Cell } from "@ckb-ccc/core";
import type { SmartTransaction, UdtHandler } from "@ickb/dao";
import { Data, Info, Relative } from "./entities.js";
import { OrderCell, OrderGroup } from "./cells.js";

export class Order {
  constructor(
    public script: ccc.Script,
    public cellDeps: ccc.CellDep[],
    public udtHandler: UdtHandler,
  ) {}

  isOrder(c: Cell): boolean {
    return (
      c.cellOutput.lock.eq(this.script) &&
      Boolean(c.cellOutput.type?.eq(this.udtHandler.script))
    );
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

  async findOrders(
    client: ccc.Client,
    // mylock?: ccc.ScriptLike,
  ): Promise<{
    orders: OrderCell[];
    myOrders: OrderGroup[];
  }> {
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
    return { orders, myOrders: [] };
  }
}
