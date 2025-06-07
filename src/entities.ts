import { ccc, mol } from "@ckb-ccc/core";
import { CheckedInt32LE, union, ExchangeRatio, gcd, max } from "@ickb/utils";

/**
 * Represents a ratio of two scales, CKB and UDT, with validation and comparison methods.
 *
 * @class Ratio
 * @extends {mol.Entity.Base<ExchangeRatio, Ratio>}
 * @codec {mol.struct({ ckbScale: mol.Uint64, udtScale: mol.Uint64 })}
 */
@mol.codec(
  mol.struct({
    ckbScale: mol.Uint64,
    udtScale: mol.Uint64,
  }),
)
export class Ratio extends mol.Entity.Base<ExchangeRatio, Ratio>() {
  /**
   * Creates an instance of Ratio.
   *
   * @param {ccc.Num} ckbScale - The scale of CKB.
   * @param {ccc.Num} udtScale - The scale of UDT.
   */
  constructor(
    public ckbScale: ccc.Num,
    public udtScale: ccc.Num,
  ) {
    super();
  }

  /**
   * Creates a Ratio instance from a ExchangeRatio object.
   *
   * @static
   * @param {ExchangeRatio} ratio - The exchange ratio object to convert.
   * @returns {Ratio} The created Ratio instance.
   */
  static override from(ratio: ExchangeRatio): Ratio {
    if (ratio instanceof Ratio) {
      return ratio;
    }

    const { ckbScale, udtScale } = ratio;
    return new Ratio(ckbScale, udtScale);
  }

  /**
   * Validates the Ratio instance.
   *
   * @throws {Error} If the Ratio is not empty and not populated.
   */
  validate(): void {
    if (!this.isEmpty() && !this.isPopulated()) {
      throw Error("Ratio invalid: not empty, not populated");
    }
  }

  /**
   * Checks if the Ratio instance is valid.
   *
   * @returns {boolean} True if valid, otherwise false.
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
   * Checks if the Ratio instance is empty.
   *
   * @returns {boolean} True if both scales are zero, otherwise false.
   */
  isEmpty(): boolean {
    return this.ckbScale === 0n && this.udtScale === 0n;
  }

  /**
   * Checks if the Ratio instance is populated.
   *
   * @returns {boolean} True if both scales are greater than zero, otherwise false.
   */
  isPopulated(): boolean {
    return this.ckbScale > 0n && this.udtScale > 0n;
  }

  /**
   * Creates an empty Ratio instance.
   *
   * @static
   * @returns {Ratio} An empty Ratio instance.
   */
  static empty(): Ratio {
    return new Ratio(0n, 0n);
  }

  /**
   * Compares this Ratio instance with another Ratio instance,
   * compare directly on ckbScale and inversely to udtScale.
   *
   * @param {Ratio} other - The other Ratio instance to compare against.
   * @returns {number} A negative number if this is less than other,
   *                   a positive number if this is greater than other,
   *                   and zero if they are equal.
   */
  compare(other: Ratio): number {
    if (this.udtScale == other.udtScale) {
      return Number(this.ckbScale - other.ckbScale);
    }

    if (this.ckbScale == other.ckbScale) {
      return Number(other.udtScale - this.udtScale);
    }

    // Idea: o0.Ckb2Udt - o1.Ckb2Udt
    // ~ o0.ckbScale / o0.udtScale - o1.ckbScale / o1.udtScale
    // order equivalent to:
    // ~ o0.ckbScale * o1.udtScale - o1.ckbScale * o0.udtScale
    return Number(
      this.ckbScale * other.udtScale - other.ckbScale * this.udtScale,
    );
  }

  /**
   * Applies a fee to the current conversion ratio.
   *
   * This method adjusts the ratio by applying a fee relative to a base value.
   * It modifies the scaling factors accordingly and reduces them by their greatest common divisor (GCD).
   * If the resulting scaling factors exceed 64 bits, they are shifted to prevent potential overflow.
   *
   * @param isCkb2Udt - Indicates the conversion direction.
   *                  - If true, the conversion is from CKB to UDT.
   *                  - Otherwise, for UDT to CKB conversion, the scaling factors are swapped.
   * @param fee - The fee to apply during conversion as a `ccc.Num`.
   *              Must be less than the provided feeBase.
   * @param feeBase - The base reference for the fee calculation as a `ccc.Num`.
   *                  Used to adjust the scaling factors and prevent oversized values.
   * @returns A new Ratio instance with the adjusted scaling factors after applying the fee.
   *
   * @throws Error if fee is greater than or equal to feeBase.
   */
  applyFee(isCkb2Udt: boolean, fee: ccc.Num, feeBase: ccc.Num): Ratio {
    if (fee >= feeBase) {
      throw Error("Fee too big respectfully to feeBase");
    }

    if (fee === 0n) {
      return this;
    }

    // Extract scaling factors from the current Ratio.
    let { ckbScale: aScale, udtScale: bScale } = this;

    // For UDT to CKB conversion, swap the scaling factors.
    if (!isCkb2Udt) {
      [aScale, bScale] = [bScale, aScale];
    }

    // Adjust scales by applying the fee.
    aScale *= feeBase - fee;
    bScale *= feeBase;

    // Reduce the ratio by dividing by the greatest common divisor.
    const g = gcd(aScale, bScale);
    aScale /= g;
    bScale /= g;

    // Prevent potential overflow by ensuring the bit length stays within 64 bits.
    const maxBitLen = max(aScale.toString(2).length, bScale.toString(2).length);
    if (maxBitLen > 64) {
      const shift = BigInt(maxBitLen - 64);
      aScale >>= shift;
      bScale >>= shift;
    }

    // Rebuild and return the adjusted ratio based on the conversion direction.
    return Ratio.from({
      ckbScale: isCkb2Udt ? aScale : bScale,
      udtScale: isCkb2Udt ? bScale : aScale,
    });
  }

  /**
   * Converts an amount between CKB and UDT based on the specified conversion direction and scaling factors.
   *
   * @param isCkb2Udt - If true, converts from CKB to UDT; if false, converts from UDT to CKB.
   * @param amount - The amount to convert, represented as a `ccc.FixedPoint`.
   * @param mustCeil - When true, applies a ceiling adjustment during conversion for rounding up;
   *                   if false, applies a floor adjustment for rounding down.
   * @returns The converted amount as a `ccc.FixedPoint` in the target unit.
   *
   * @throws Error if the ExchangeRatio instance is not properly populated.
   *
   * @remarks
   * The conversion is achieved using the internal scaling factors:
   * - `ckbScale` is used when converting from CKB.
   * - `udtScale` is used when converting from UDT.
   *
   * If the conversion direction is from UDT to CKB, the scales are swapped.
   * The adjustment is determined by the `mustCeil` flag:
   * - If `mustCeil` is true, an adjustment of `(udtScale - 1n)` is applied to round up.
   * - Otherwise, no adjustment (i.e., `0n`) is applied for rounding down.
   */
  convert(
    isCkb2Udt: boolean,
    amount: ccc.FixedPoint,
    mustCeil: boolean,
  ): ccc.FixedPoint {
    if (!this.isPopulated()) {
      throw Error("Invalid midpoint ExchangeRatio");
    }

    if (amount === 0n) {
      return 0n;
    }

    let { ckbScale: aScale, udtScale: bScale } = this;
    if (!isCkb2Udt) {
      // For UDT to CKB conversion, swap the scaling factors.
      [aScale, bScale] = [bScale, aScale];
    }

    // Apply ceiling adjustment when necessary; otherwise, use floor adjustment.
    return (amount * aScale + (mustCeil ? bScale - 1n : 0n)) / bScale;
  }
}

/**
 * Represents a structure containing conversion ratios and a minimum match log value.
 *
 * @interface InfoLike
 */
export interface InfoLike {
  /**
   * The ratio for converting CKB to UDT.
   *
   * @type {ExchangeRatio}
   */
  ckbToUdt: ExchangeRatio;

  /**
   * The ratio for converting UDT to CKB.
   *
   * @type {ExchangeRatio}
   */
  udtToCkb: ExchangeRatio;

  /**
   * The minimum match log value for CKB.
   *
   * @type {ccc.FixedPointLike}
   */
  ckbMinMatchLog: ccc.FixedPointLike;
}

/**
 * Represents conversion information between CKB and UDT, including validation and comparison methods.
 *
 * @class Info
 * @extends {mol.Entity.Base<InfoLike, Info>}
 * @codec {mol.struct({ ckbToUdt: Ratio, udtToCkb: Ratio, ckbMinMatchLog: mol.Uint8 })}
 */
@mol.codec(
  mol.struct({
    ckbToUdt: Ratio,
    udtToCkb: Ratio,
    ckbMinMatchLog: mol.Uint8,
  }),
)
export class Info extends mol.Entity.Base<InfoLike, Info>() {
  /**
   * Creates an instance of Info.
   *
   * @param {Ratio} ckbToUdt - The ratio for converting CKB to UDT.
   * @param {Ratio} udtToCkb - The ratio for converting UDT to CKB.
   * @param {number} ckbMinMatchLog - The minimum match log value for CKB.
   */
  constructor(
    public ckbToUdt: Ratio,
    public udtToCkb: Ratio,
    public ckbMinMatchLog: number,
  ) {
    super();
  }

  /**
   * Creates an Info instance from an InfoLike object.
   *
   * @static
   * @param {InfoLike} info - The info-like object to convert.
   * @returns {Info} The created Info instance.
   */
  static override from(info: InfoLike): Info {
    if (info instanceof Info) {
      return info;
    }

    const { ckbToUdt, udtToCkb, ckbMinMatchLog } = info;
    return new Info(
      Ratio.from(ckbToUdt),
      Ratio.from(udtToCkb),
      Number(ckbMinMatchLog),
    );
  }

  /**
   * Creates a new Info instance based on the provided parameters.
   *
   * @static
   * @param {boolean} isCkb2Udt - Indicates if the conversion is from CKB to UDT.
   * @param {ExchangeRatio} ratioLike - The ratio to use for conversion.
   * @param {number} [ckbMinMatchLog] - The minimum match log value for CKB (Default: 33, about 86 CKB)
   * @returns {Info} The created Info instance.
   */
  static create(
    isCkb2Udt: boolean,
    ratioLike: ExchangeRatio,
    ckbMinMatchLog = Info.ckbMinMatchLogDefault(),
  ): Info {
    return Info.from({
      ckbToUdt: isCkb2Udt ? ratioLike : Ratio.empty(),
      udtToCkb: isCkb2Udt ? Ratio.empty() : ratioLike,
      ckbMinMatchLog,
    });
  }

  /**
   * Validates the Info instance.
   *
   * @throws {Error} If the Info instance is invalid based on its properties.
   */
  validate(): void {
    if (this.ckbMinMatchLog < 0 || this.ckbMinMatchLog > 64) {
      throw Error("ckbMinMatchLog invalid");
    }

    if (this.ckbToUdt.isEmpty()) {
      if (this.udtToCkb.isPopulated()) {
        return;
      } else {
        throw Error("ckbToUdt is Empty, but udtToCkb is not Populated");
      }
    }

    if (this.udtToCkb.isEmpty()) {
      if (this.ckbToUdt.isPopulated()) {
        return;
      } else {
        throw Error("udtToCkb is Empty, but ckbToUdt is not Populated");
      }
    }

    if (!this.ckbToUdt.isPopulated() || !this.udtToCkb.isPopulated()) {
      throw Error("One ratio is invalid, so not Empty and not Populated");
    }

    // Check that if we convert from ckb to udt and then back from udt to ckb, it doesn't lose value.
    if (
      this.ckbToUdt.ckbScale * this.udtToCkb.udtScale <
      this.ckbToUdt.udtScale * this.udtToCkb.ckbScale
    ) {
      throw Error("udtToCkb and ckbToUdt allow order value to be extracted");
    }
  }

  /**
   * Checks if the Info instance is valid.
   *
   * @returns {boolean} True if valid, otherwise false.
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
   * Gets the minimum match value for CKB as a fixed point.
   *
   * @returns {ccc.FixedPoint} The minimum match value for CKB.
   */
  getCkbMinMatch(): ccc.FixedPoint {
    return 1n << BigInt(this.ckbMinMatchLog);
  }

  /**
   * Checks if the Info instance represents a CKB to UDT conversion or dual ratio.
   *
   * @returns {boolean} True if it is a CKB to UDT conversion, otherwise false.
   */
  isCkb2Udt(): boolean {
    return this.ckbToUdt.isPopulated();
  }

  /**
   * Checks if the Info instance represents a UDT to CKB conversion or dual ratio.
   *
   * @returns {boolean} True if it is a UDT to CKB conversion, otherwise false.
   */
  isUdt2Ckb(): boolean {
    return this.udtToCkb.isPopulated();
  }

  /**
   * Checks if the Info instance represents a dual ratio (both conversions).
   *
   * @returns {boolean} True if both conversions are populated, otherwise false.
   */
  isDualRatio(): boolean {
    return this.isCkb2Udt() && this.isUdt2Ckb();
  }

  /**
   * Compares the CKB to UDT ratio of this Info instance with another Info instance.
   *
   * @param {Info} other - The other Info instance to compare against.
   * @returns {number} A negative number if this is less than other,
   *                   a positive number if this is greater than other,
   *                   and zero if they are equal.
   */
  ckb2UdtCompare(other: Info): number {
    return this.ckbToUdt.compare(other.ckbToUdt);
  }

  /**
   * Compares the UDT to CKB ratio of this Info instance with another Info instance.
   *
   * @param {Info} other - The other Info instance to compare against.
   * @returns {number} A negative number if this is less than other,
   *                   a positive number if this is greater than other,
   *                   and zero if they are equal.
   */
  udt2CkbCompare(other: Info): number {
    return other.udtToCkb.compare(this.udtToCkb);
  }

  /**
   * Provides the default minimum match log value for CKB, which is 86 CKB.
   *
   * @static
   * @returns {number} The default minimum match log value.
   */
  static ckbMinMatchLogDefault(): number {
    return 33; // ~ 86 CKB
  }
}

/**
 * Represents a structure containing padding and distance values.
 *
 * @interface RelativeLike
 */
export interface RelativeLike {
  /**
   * The padding value, represented as bytes.
   *
   * @type {ccc.BytesLike}
   */
  padding: ccc.BytesLike;

  /**
   * The distance value, represented as a number.
   *
   * @type {ccc.NumLike}
   */
  distance: ccc.NumLike;
}

/**
 * Represents a relative structure with padding and distance, including validation methods.
 *
 * @class Relative
 * @extends {mol.Entity.Base<RelativeLike, Relative>}
 * @codec {mol.struct({ padding: mol.Byte32, distance: CheckedInt32LE })}
 */
@mol.codec(
  mol.struct({
    padding: mol.Byte32,
    distance: CheckedInt32LE,
  }),
)
export class Relative extends mol.Entity.Base<RelativeLike, Relative>() {
  /**
   * Creates an instance of Relative.
   *
   * @param {ccc.Bytes} padding - The padding value.
   * @param {ccc.Num} distance - The distance value.
   */
  constructor(
    public padding: ccc.Bytes,
    public distance: ccc.Num,
  ) {
    super();
  }

  /**
   * Creates a Relative instance from a RelativeLike object.
   *
   * @static
   * @param {RelativeLike} relative - The relative-like object to convert.
   * @returns {Relative} The created Relative instance.
   */
  static override from(relative: RelativeLike): Relative {
    if (relative instanceof Relative) {
      return relative;
    }

    const { padding, distance } = relative;
    return new Relative(ccc.bytesFrom(padding), ccc.numFrom(distance));
  }

  /**
   * Creates a new Relative instance with default padding and the specified distance.
   *
   * @static
   * @param {ccc.Num} distance - The distance value.
   * @returns {Relative} The created Relative instance.
   */
  static create(distance: ccc.Num): Relative {
    return new Relative(Relative.padding(), distance);
  }

  /**
   * Provides the default padding value as a byte array of length 32.
   *
   * @static
   * @returns {ccc.Bytes} The default padding value.
   */
  static padding(): ccc.Bytes {
    return new Uint8Array(32);
  }

  /**
   * Validates the Relative instance.
   *
   * @throws {Error} If the padding is not of length 32 or contains non-zero values.
   */
  validate(): void {
    if (this.padding.length != 32 || this.padding.some((x) => x !== 0)) {
      throw Error("Relative master invalid, non standard padding");
    }
  }

  /**
   * Checks if the Relative instance is valid.
   *
   * @returns {boolean} True if valid, otherwise false.
   */
  isValid(): boolean {
    try {
      this.validate();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * A union codec that can encode and decode either a Relative or an Absolute OutPoint.
 *
 * @constant MasterCodec
 * @type {mol.UnionCodec<{ relative: Relative; absolute: ccc.OutPoint; }>}
 */
export const MasterCodec = union({
  relative: Relative,
  absolute: ccc.OutPoint,
});

/**
 * Represents a type that can be encoded using the MasterCodec.
 *
 * @type {MasterLike}
 */
export type MasterLike = mol.EncodableType<typeof MasterCodec>;

/**
 * Represents a type that has been decoded using the MasterCodec.
 *
 * @type {Master}
 */
export type Master = mol.DecodedType<typeof MasterCodec>;

/**
 * Converts a MasterLike object to a Master object.
 *
 * @param {MasterLike} master - The master-like object to convert.
 * @returns {Master} The converted Master object.
 * @throws {Error} If the type is not "relative" or "absolute".
 */
function masterFrom(master: MasterLike): Master {
  const { type, value } = master;
  if (type === "relative") {
    return { type, value: Relative.from(value) };
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  } else if (type === "absolute") {
    return { type, value: ccc.OutPoint.from(value) };
  } else {
    throw Error(`Invalid type ${String(type)}, not relative, not absolute`);
  }
}
/**
 * Validates a Master object, ensuring that it conforms to the expected structure
 * based on its type (either "relative" or "absolute").
 *
 * @param {Master} master - The Master object to validate.
 * @throws {Error} If the Master object is of an invalid type or if the validation
 *                 checks for the specific type fail.
 */
function masterValidate(master: Master): void {
  const { type, value } = master;
  if (type === "relative") {
    value.validate();
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  } else if (type === "absolute") {
    if (!/^0x[0-9a-f]{64}$/i.test(value.txHash) || value.index < 0) {
      throw Error("OutPoint invalid");
    }
  } else {
    throw Error(`Invalid type ${String(type)}, not relative, not absolute`);
  }
}

/**
 * Represents a structure containing UDT amount, master information, and additional info.
 *
 * @interface OrderDataLike
 */
export interface OrderDataLike {
  /**
   * The amount of UDT (User Defined Token).
   *
   * @type {ccc.FixedPointLike}
   */
  udtValue: ccc.FixedPointLike;

  /**
   * The master information, which can be either relative or absolute.
   *
   * @type {MasterLike}
   */
  master: MasterLike;

  /**
   * Additional information related to the data.
   *
   * @type {InfoLike}
   */
  info: InfoLike;
}

/**
 * Represents a data structure that includes UDT amount, master, and info,
 * with validation and utility methods.
 *
 * @class Data
 * @extends {mol.Entity.Base<OrderDataLike, OrderData>}
 * @codec {mol.struct({ udtValue: mol.Uint128, master: MasterCodec, info: Info })}
 */
@mol.codec(
  mol.struct({
    udtValue: mol.Uint128,
    master: MasterCodec,
    info: Info,
  }),
)
export class OrderData extends mol.Entity.Base<OrderDataLike, OrderData>() {
  /**
   * Creates an instance of OrderData.
   *
   * @param {ccc.FixedPoint} udtValue - The amount of UDT.
   * @param {Master} master - The master information.
   * @param {Info} info - The additional information.
   */
  constructor(
    public udtValue: ccc.FixedPoint,
    public master: Master,
    public info: Info,
  ) {
    super();
  }

  /**
   * Creates a OrderData instance from a OrderDataLike object.
   *
   * @static
   * @param {OrderDataLike} data - The data-like object to convert.
   * @returns {OrderData} The created Data instance.
   */
  static override from(data: OrderDataLike): OrderData {
    if (data instanceof OrderData) {
      return data;
    }

    const { udtValue, master, info } = data;
    return new OrderData(
      ccc.numFrom(udtValue),
      masterFrom(master),
      Info.from(info),
    );
  }

  /**
   * Validates the Data instance.
   *
   * @throws {Error} If the UDT amount is negative or if the master or info are invalid.
   */
  validate(): void {
    if (this.udtValue < 0) {
      throw Error("udtValue invalid, negative");
    }
    masterValidate(this.master);
    this.info.validate();
  }

  /**
   * Checks if the Data instance is valid.
   *
   * @returns {boolean} True if valid, otherwise false.
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
   * Checks if the Data instance represents a mint operation.
   *
   * @returns {boolean} True if the master type is "relative", otherwise false.
   */
  isMint(): boolean {
    return this.master.type === "relative";
  }

  /**
   * Gets the master OutPoint based on the current OutPoint.
   *
   * @param {ccc.OutPoint} current - The current OutPoint to use for calculation.
   * @returns {ccc.OutPoint} The calculated master OutPoint.
   * @throws {Error} If the master type is invalid.
   */
  getMaster(current: ccc.OutPoint): ccc.OutPoint {
    const { type, value } = this.master;
    if (type === "relative") {
      return new ccc.OutPoint(current.txHash, current.index + value.distance);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    } else if (type === "absolute") {
      return value;
    } else {
      throw Error(`Invalid type ${String(type)}, not relative, not absolute`);
    }
  }
}
