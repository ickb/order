import { ccc } from "@ckb-ccc/core";
import type { SmartTransaction, UdtHandler } from "@ickb/dao";
import { Data, Info, Relative } from "./entities.js";
import type { MasterCell, OrderCell } from "./cells.js";

export class Order {
  constructor(
    public script: ccc.Script,
    public cellDeps: ccc.CellDep[],
    public udtHandler: UdtHandler,
  ) {}

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
    if (!o.cell.cellOutput.lock.eq(this.script)) {
      throw Error("Match impossible with non-order cell");
    }

    if (!o.cell.cellOutput.type?.eq(this.udtHandler.script)) {
      throw Error("Match impossible with different UDT type");
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

  melt(tx: SmartTransaction, o: OrderCell, master: MasterCell): void {
    if (!o.cell.cellOutput.lock.eq(this.script)) {
      throw Error("Melt impossible with non-order cell");
    }

    if (!o.cell.cellOutput.type?.eq(this.udtHandler.script)) {
      throw Error("Melt impossible with different UDT type");
    }

    master.validateDescendant(o);

    tx.addCellDeps(this.cellDeps);
    tx.addUdtHandlers(this.udtHandler);

    tx.addInput(o.cell);
    tx.addInput(master.cell);
  }
}
