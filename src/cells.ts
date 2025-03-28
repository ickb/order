import { ccc, type FixedPoint } from "@ckb-ccc/core";
import { Data } from "./entities.js";

/**
 * Represents an order cell in the system.
 */
export class OrderCell {
  /**
   * Creates an instance of OrderCell.
   * @param cell - The cell associated with the order.
   * @param data - The data related to the order.
   * @param ckbOccupied - The amount of CKB occupied by the order.
   * @param ckbUnoccupied - The amount of CKB unoccupied by the order.
   * @param absTotal - The absolute total value of the order.
   * @param absProgress - The absolute progress of the order.
   */
  constructor(
    public cell: ccc.Cell,
    public data: Data,
    public ckbOccupied: ccc.FixedPoint,
    public ckbUnoccupied: ccc.FixedPoint,
    public absTotal: ccc.Num,
    public absProgress: ccc.Num,
  ) {}

  /**
   * Tries to create an OrderCell from a given cell.
   * @param cell - The cell to create the OrderCell from.
   * @returns An OrderCell instance or undefined if creation fails.
   */
  static tryFrom(cell: ccc.Cell): OrderCell | undefined {
    try {
      return OrderCell.mustFrom(cell);
    } catch {
      return undefined;
    }
  }

  /**
   * Creates an OrderCell from a given cell, throwing an error if the cell is invalid.
   * @param cell - The cell to create the OrderCell from.
   * @returns An OrderCell instance.
   * @throws Will throw an error if the cell is invalid.
   */
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

  /**
   * Checks if the order can be matched as a CKB to UDT order.
   * @returns True if the order is matchable as CKB to UDT, otherwise false.
   */
  isCkb2UdtMatchable(): boolean {
    return this.data.info.isCkb2Udt() && this.ckbUnoccupied > 0n;
  }

  /**
   * Checks if the order can be matched as a UDT to CKB order.
   * @returns True if the order is matchable as UDT to CKB, otherwise false.
   */
  isUdt2CkbMatchable(): boolean {
    return this.data.info.isUdt2Ckb() && this.data.udtAmount > 0n;
  }

  /**
   * Checks if the order is matchable in any way.
   * @returns True if the order is matchable, otherwise false.
   */
  isMatchable(): boolean {
    return this.isCkb2UdtMatchable() || this.isUdt2CkbMatchable();
  }

  /**
   * Retrieves the master out point of the order.
   * @returns The master out point associated with the order.
   */
  getMaster(): ccc.OutPoint {
    return this.data.getMaster(this.cell.outPoint);
  }

  /**
   * Gets the amounts of CKB and UDT in the order.
   * @returns An object containing the CKB and UDT amounts.
   */
  getAmounts(): { ckbIn: ccc.FixedPoint; udtIn: ccc.FixedPoint } {
    return {
      ckbIn: this.cell.cellOutput.capacity,
      udtIn: this.data.udtAmount,
    };
  }

  /**
   * Matches the order based on the specified parameters.
   * @param isCkb2Udt - Indicates if the match is for CKB to UDT.
   * @param allowanceStep - The step allowance for matching.
   * @returns A generator yielding match results.
   */
  *match(
    isCkb2Udt: boolean,
    allowanceStep: ccc.FixedPoint,
  ): Generator<Match, void, void> {
    let aScale: ccc.Num;
    let bScale: ccc.Num;
    let aIn: ccc.FixedPoint;
    let bIn: ccc.FixedPoint;
    let aOut: ccc.FixedPoint;
    let bOut: ccc.FixedPoint;
    let aMinMatch: ccc.FixedPoint;
    let aMin: FixedPoint;
    let newMatch: () => Match;

    if (isCkb2Udt) {
      ({ ckbScale: aScale, udtScale: bScale } = this.data.info.ckbToUdt);
      ({ ckbIn: aIn, udtIn: bIn } = this.getAmounts());
      aMinMatch = this.data.info.getCkbMinMatch();
      aMin = this.ckbOccupied;
      newMatch = (): Match => ({
        ckbOut: aOut,
        udtOut: bOut,
        ckbDelta: aOut - aIn,
        udtDelta: bOut - bIn,
        isFulfilled: aOut === aMin,
      });
    } else {
      ({ ckbScale: bScale, udtScale: aScale } = this.data.info.ckbToUdt);
      ({ ckbIn: bIn, udtIn: aIn } = this.getAmounts());
      aMinMatch =
        (this.data.info.getCkbMinMatch() * bScale + aScale - 1n) / aScale;
      aMin = ccc.Zero;
      newMatch = (): Match => ({
        ckbOut: bOut,
        udtOut: aOut,
        ckbDelta: bOut - bIn,
        udtDelta: aOut - aIn,
        isFulfilled: aOut === aMin,
      });
    }

    if (aIn <= aMin || aScale <= 0n || bScale <= 0n || allowanceStep <= 0) {
      return;
    }

    bOut = bIn + allowanceStep;
    aOut = getNonDecreasing(bScale, aScale, bIn, aIn, bOut);

    // Check if allowanceStep was too low to even fulfill partially
    if (aOut + aMinMatch > aIn) {
      return;
    }

    while (aMin < aOut) {
      yield newMatch();

      bOut += allowanceStep;
      aOut = getNonDecreasing(bScale, aScale, bIn, aIn, bOut);
    }

    // Check if order was over-fulfilled
    if (aOut < aMin) {
      // Fulfill fully the order
      aOut = aMin;
      bOut = getNonDecreasing(aScale, bScale, aIn, bIn, aOut);
    }

    yield newMatch();
  }

  /**
   * Countermeasure to Confusion Attack https://github.com/ickb/whitepaper/issues/19
   * Validates the order against a descendant order.
   * @param descendant - The descendant order to validate against.
   * @throws Will throw an error if validation fails.
   */
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

  /**
   * Checks if the descendant order is valid against this order.
   * @param descendant - The descendant order to validate.
   * @returns True if the descendant is valid, otherwise false.
   */
  isValid(descendant: OrderCell): boolean {
    try {
      this.validate(descendant);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Countermeasure to Confusion Attack https://github.com/ickb/whitepaper/issues/19
   * Resolves the best descendant order from a list of descendants.
   * @param descendants - The list of descendant orders to resolve.
   * @returns The best matching descendant order or undefined if none is valid.
   */
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

/**
 * Represents a match result between orders.
 */
export interface Match {
  ckbOut: ccc.FixedPoint; // The amount of CKB output.
  udtOut: ccc.FixedPoint; // The amount of UDT output.
  ckbDelta: ccc.FixedPoint; // The change in CKB.
  udtDelta: ccc.FixedPoint; // The change in UDT.
  isFulfilled: boolean; // Indicates if the match is fulfilled.
}

/**
 * Represents a group of orders associated with a master cell.
 */
export class OrderGroup {
  /**
   * Creates an instance of OrderGroup.
   * @param master - The master cell associated with the order group.
   * @param order - The order within the group.
   * @param origin - The original order associated with the group.
   */
  constructor(
    public master: ccc.Cell,
    public order: OrderCell,
    public origin: OrderCell,
  ) {}

  /**
   * Tries to create an OrderGroup from the provided parameters.
   * @param master - The master cell.
   * @param order - The order within the group.
   * @param origin - The original order.
   * @returns An OrderGroup instance or undefined if creation fails.
   */
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

  /**
   * Validates the order group against its master and origin orders.
   * @throws Will throw an error if validation fails.
   */
  validate(): void {
    if (!this.master.cellOutput.type?.eq(this.order.cell.cellOutput.lock)) {
      throw Error("Order script different");
    }

    if (!this.order.getMaster().eq(this.master.outPoint)) {
      throw Error("Master is different");
    }

    this.origin.validate(this.order);
  }

  /**
   * Checks if the order group is valid.
   * @returns True if the order group is valid, otherwise false.
   */
  isValid(): boolean {
    try {
      this.validate();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Checks if the specified lock is the owner of the master cell.
   * @param lock - The lock to check ownership against.
   * @returns True if the lock is the owner, otherwise false.
   */
  /**
   * Checks if the specified lock is the owner of the master cell.
   * @param lock - The lock to check ownership against.
   * @returns True if the lock is the owner, otherwise false.
   */
  isOwner(lock: ccc.ScriptLike): boolean {
    return this.master.cellOutput.lock.eq(lock);
  }
}

/**
 * Applies limit order rule on non-decreasing value to calculate bOut:
 * min bOut such that aScale * aIn + bScale * bIn <= aScale * aOut + bScale * bOut
 * bOut = (aScale * (aIn - aOut) + bScale * bIn) / bScale
 * But integer divisions truncate, so we need to round to the upper value
 * bOut = (aScale * (aIn - aOut) + bScale * (bIn + 1) - 1) / bScale
 */
function getNonDecreasing(
  aScale: ccc.Num,
  bScale: ccc.Num,
  aIn: ccc.FixedPoint,
  bIn: ccc.FixedPoint,
  aOut: ccc.FixedPoint,
): ccc.FixedPoint {
  return (aScale * (aIn - aOut) + bScale * (bIn + 1n) - 1n) / bScale;
}
