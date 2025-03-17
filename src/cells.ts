import { ccc } from "@ckb-ccc/core";
import { getCkbOccupied } from "@ickb/dao";
import { Data } from "./entities.js";

export class OrderCell {
  constructor(
    public cell: ccc.Cell,
    public data: Data,
    public ckbOccupied: ccc.FixedPoint,
    public ckbUnoccupied: ccc.FixedPoint,
    public absTotal: ccc.Num,
    public absProgress: ccc.Num,
  ) {}

  static tryFrom(cell: ccc.Cell): OrderCell | undefined {
    try {
      return OrderCell.createFrom(cell);
    } catch {
      return undefined;
    }
  }

  static createFrom(cell: ccc.Cell): OrderCell {
    const data = Data.decode(cell.outputData);
    data.validate();

    const udtAmount = data.udtAmount;
    const ckbOccupied = getCkbOccupied(cell);
    const ckbUnoccupied = cell.cellOutput.capacity - ckbOccupied;

    const { ckbToUdt, udtToCkb } = data.info;
    const isCkb2Udt = data.info.isCkb2Udt();
    const isUdt2Ckb = data.info.isUdt2Ckb();

    // Calculate completion progress, relProgress= 100*Number(absProgress)/Number(absTotal)
    const ckb2UdtValue = isCkb2Udt
      ? ckbUnoccupied * ckbToUdt.ckbScale + udtAmount * ckbToUdt.udtScale
      : 0n;
    const udt2CkbValue = isUdt2Ckb
      ? ckbUnoccupied * udtToCkb.ckbScale + udtAmount * udtToCkb.udtScale
      : 0n;
    const absTotal =
      ckb2UdtValue === 0n
        ? udt2CkbValue
        : udt2CkbValue === 0n
          ? ckb2UdtValue
          : // Take the average of the two values for dual ratio orders
            (ckb2UdtValue * udtToCkb.ckbScale * udtToCkb.udtScale +
              udt2CkbValue * ckbToUdt.ckbScale * ckbToUdt.udtScale) >>
            1n;

    const absProgress = data.info.isDualRatio()
      ? absTotal
      : isCkb2Udt
        ? udtAmount * ckbToUdt.udtScale
        : ckbUnoccupied * udtToCkb.ckbScale;

    return new OrderCell(
      cell,
      data,
      ckbOccupied,
      ckbUnoccupied,
      absTotal,
      absProgress,
    );
  }

  isCkb2UdtMatchable(): boolean {
    return this.data.info.isCkb2Udt() && this.ckbUnoccupied > 0n;
  }

  isUdt2CkbMatchable(): boolean {
    return this.data.info.isUdt2Ckb() && this.data.udtAmount > 0n;
  }

  isMatchable(): boolean {
    return this.isCkb2UdtMatchable() || this.isUdt2CkbMatchable();
  }

  getMaster(): ccc.OutPoint {
    return this.data.getMaster(this.cell.outPoint);
  }

  matchCkb2Udt(udtAllowance: ccc.FixedPoint): {
    isFulfilled: boolean;
    ckbOut: ccc.FixedPoint;
    udtOut: ccc.FixedPoint;
  } {
    if (!this.isCkb2UdtMatchable()) {
      throw Error("Match impossible in CKB to UDT direction");
    }
    this.data.validate();

    const { ckbScale, udtScale } = this.data.info.ckbToUdt;
    const ckbIn = this.cell.cellOutput.capacity;
    const udtIn = this.data.udtAmount;

    {
      // Try to fulfill completely the order
      const ckbOut = this.ckbOccupied;
      const udtOut = getNonDecreasing(ckbScale, udtScale, ckbIn, udtIn, ckbOut);
      if (udtIn + udtAllowance >= udtOut) {
        return {
          isFulfilled: true,
          ckbOut,
          udtOut,
        };
      }
    }

    {
      // UDT allowance limits the order fulfillment
      const udtOut = udtIn + udtAllowance;
      const ckbOut = getNonDecreasing(udtScale, ckbScale, udtIn, ckbIn, udtOut);
      // DOS prevention: ckbMinMatch is the minimum partial match.
      if (ckbIn < ckbOut + this.data.info.getCkbMinMatch()) {
        throw Error("UDT Allowance too low");
      }

      return {
        isFulfilled: false,
        ckbOut,
        udtOut,
      };
    }
  }

  matchUdt2Ckb(ckbAllowance: ccc.FixedPoint): {
    isFulfilled: boolean;
    ckbOut: ccc.FixedPoint;
    udtOut: ccc.FixedPoint;
  } {
    if (!this.isUdt2CkbMatchable()) {
      throw Error("Match impossible in UDT to CKB direction");
    }
    this.data.validate();

    const { udtScale, ckbScale } = this.data.info.udtToCkb;
    const udtIn = this.data.udtAmount;
    const ckbIn = this.cell.cellOutput.capacity;

    {
      // Try to fulfill completely the order
      const udtOut = ccc.Zero;
      const ckbOut = getNonDecreasing(udtScale, ckbScale, udtIn, ckbIn, udtOut);
      if (ckbIn + ckbAllowance >= ckbOut) {
        return {
          isFulfilled: true,
          ckbOut,
          udtOut,
        };
      }
    }

    {
      // CKB allowance limits the order fulfillment
      const ckbOut = ckbIn + ckbAllowance;
      const udtOut = getNonDecreasing(ckbScale, udtScale, ckbIn, udtIn, ckbOut);
      // DoS prevention: the equivalent of ckbMinMatch is the minimum partial match.
      if (
        udtIn * udtScale <
        udtOut * udtScale + this.data.info.getCkbMinMatch() * ckbScale
      ) {
        throw Error("CKB Allowance too low");
      }

      return {
        isFulfilled: false,
        ckbOut,
        udtOut,
      };
    }
  }

  // Countermeasure to Confusion Attack https://github.com/ickb/whitepaper/issues/19
  validate(descendant: OrderCell): void {
    // Same cell, nothing to check
    if (this.cell.outPoint.eq(descendant.cell.outPoint)) {
      return;
    }

    if (!this.cell.cellOutput.lock.eq(descendant.cell.cellOutput.lock)) {
      throw Error("Order script different");
    }

    const udt = this.cell.cellOutput.type;
    if (!udt || !descendant.cell.cellOutput.type?.eq(udt)) {
      throw Error("UDT type is different");
    }

    if (!descendant.getMaster().eq(this.getMaster())) {
      throw Error("Master is different");
    }

    if (!this.data.info.eq(this.data.info)) {
      throw Error("Info is different");
    }

    if (this.absTotal > descendant.absTotal) {
      throw Error("Total value is lower than the original one");
    }

    if (this.absProgress > descendant.absProgress) {
      throw Error("Progress is lower than the original one");
    }
  }

  // Countermeasure to Confusion Attack https://github.com/ickb/whitepaper/issues/19
  resolve(descendants: OrderCell[]): OrderCell | undefined {
    let best: OrderCell | undefined = undefined;
    for (const descendant of descendants) {
      try {
        this.validate(descendant);
      } catch {
        continue;
      }

      if (descendant.absProgress > (best?.absProgress ?? -1n)) {
        best = descendant;
      }
    }

    return best;
  }
}

// Apply limit order rule on non decreasing value to calculate bOut:
// min bOut such that aScale * aIn + bScale * bIn <= aScale * aOut + bScale * bOut
// bOut = (aScale * (aIn - aOut) + bScale * bIn) / bScale
// But integer divisions truncate, so we need to round to the upper value
// bOut = (aScale * (aIn - aOut) + bScale * bIn + bScale - 1) / bScale
// bOut = (aScale * (aIn - aOut) + bScale * (bIn + 1) - 1) / bScale
function getNonDecreasing(
  aScale: ccc.Num,
  bScale: ccc.Num,
  aIn: ccc.FixedPoint,
  bIn: ccc.FixedPoint,
  aOut: ccc.FixedPoint,
): ccc.FixedPoint {
  return (aScale * (aIn - aOut) + bScale * (bIn + 1n) - 1n) / bScale;
}

export class OrderGroup {
  constructor(
    public master: ccc.Cell,
    public order: OrderCell,
    public origin: OrderCell,
  ) {}

  validate(): void {
    if (!this.master.cellOutput.type?.eq(this.order.cell.cellOutput.lock)) {
      throw Error("Order script different");
    }

    if (!this.order.getMaster().eq(this.master.outPoint)) {
      throw Error("Master is different");
    }

    this.origin.validate(this.order);
  }

  isOwner(lock: ccc.ScriptLike): boolean {
    return this.master.cellOutput.lock.eq(lock);
  }
}
