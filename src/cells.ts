import { ccc, type FixedPoint } from "@ckb-ccc/core";
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
      return OrderCell.mustFrom(cell);
    } catch {
      return undefined;
    }
  }

  static mustFrom(cell: ccc.Cell): OrderCell {
    const data = Data.decode(cell.outputData);
    data.validate();

    const udtAmount = data.udtAmount;
    const ckbUnoccupied = cell.capacityFree;
    const ckbOccupied = cell.cellOutput.capacity - cell.capacityFree;

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

  getAmounts(): { ckbIn: ccc.FixedPoint; udtIn: ccc.FixedPoint } {
    return {
      ckbIn: this.cell.cellOutput.capacity,
      udtIn: this.data.udtAmount,
    };
  }

  *match(
    isCkb2Udt: boolean,
    allowanceStep: ccc.FixedPoint,
  ): Generator<
    {
      aOut: bigint;
      bOut: bigint;
      aDelta: bigint;
      bDelta: bigint;
      isFulfilled: boolean;
    },
    void,
    void
  > {
    let aScale: ccc.Num;
    let bScale: ccc.Num;
    let aIn: ccc.FixedPoint;
    let bIn: ccc.FixedPoint;
    let aMinMatch: ccc.FixedPoint;
    let aMin: FixedPoint;
    if (isCkb2Udt) {
      ({ ckbScale: aScale, udtScale: bScale } = this.data.info.ckbToUdt);
      ({ ckbIn: aIn, udtIn: bIn } = this.getAmounts());
      aMinMatch = this.data.info.getCkbMinMatch();
      aMin = this.ckbOccupied;
    } else {
      ({ ckbScale: bScale, udtScale: aScale } = this.data.info.ckbToUdt);
      ({ ckbIn: bIn, udtIn: aIn } = this.getAmounts());
      aMinMatch =
        (this.data.info.getCkbMinMatch() * bScale + aScale - 1n) / aScale;
      aMin = ccc.Zero;
    }

    if (aIn <= aMin || aScale <= 0n || bScale <= 0n || allowanceStep <= 0) {
      return;
    }

    let bOut = bIn + allowanceStep;
    let [aOut, bDelta, aDelta] = getNonDecreasing(
      bScale,
      aScale,
      bIn,
      aIn,
      bOut,
    );

    //Check if allowanceStep was too low to even fulfill partially
    if (aOut + aMinMatch > aIn) {
      return;
    }

    while (aMin < aOut) {
      yield { aOut, bOut, aDelta, bDelta, isFulfilled: false };

      bOut += allowanceStep;
      [aOut, bDelta, aDelta] = getNonDecreasing(bScale, aScale, bIn, aIn, bOut);
    }

    //Check if order was over-fulfilled
    if (aOut < aMin) {
      aOut = aMin;
      [bOut, aDelta, bDelta] = getNonDecreasing(aScale, bScale, aIn, bIn, aOut);
    }

    yield { aOut, bOut, aDelta, bDelta, isFulfilled: true };
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

  isValid(descendant: OrderCell): boolean {
    try {
      this.validate(descendant);
      return true;
    } catch {
      return false;
    }
  }

  // Countermeasure to Confusion Attack https://github.com/ickb/whitepaper/issues/19
  resolve(descendants: OrderCell[]): OrderCell | undefined {
    let best: OrderCell | undefined = undefined;
    for (const descendant of descendants) {
      if (!this.isValid(descendant)) {
        continue;
      }

      // Pick order with best absProgress. At equality of absProgress, give preference to newly minted orders
      if (
        !best ||
        best.absProgress < descendant.absProgress ||
        (best.absProgress === descendant.absProgress && !best.data.isMint())
      ) {
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
): [ccc.FixedPoint, ccc.FixedPoint, ccc.FixedPoint] {
  const bOut = (aScale * (aIn - aOut) + bScale * (bIn + 1n) - 1n) / bScale;
  const aDelta = aOut - aIn;
  const bDelta = bOut - bIn;
  return [bOut, aDelta, bDelta];
}

export class OrderGroup {
  constructor(
    public master: ccc.Cell,
    public order: OrderCell,
    public origin: OrderCell,
  ) {}

  static tryFrom(
    master: ccc.Cell,
    order: OrderCell,
    origin: OrderCell,
  ): OrderGroup | undefined {
    const og = new OrderGroup(master, order, origin);
    if (og.isValid()) {
      return og;
    }
    return undefined;
  }

  validate(): void {
    if (!this.master.cellOutput.type?.eq(this.order.cell.cellOutput.lock)) {
      throw Error("Order script different");
    }

    if (!this.order.getMaster().eq(this.master.outPoint)) {
      throw Error("Master is different");
    }

    this.origin.validate(this.order);
  }

  isValid(): boolean {
    try {
      this.validate();
      return true;
    } catch {
      return false;
    }
  }

  isOwner(lock: ccc.ScriptLike): boolean {
    return this.master.cellOutput.lock.eq(lock);
  }
}
