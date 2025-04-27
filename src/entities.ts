import { ccc, mol } from "@ckb-ccc/core";
import { CheckedInt32LE, union } from "@ickb/utils";

/**
 * Represents a ratio-like structure that contains two scales.
 *
 * @interface RatioLike
 */
export interface RatioLike {
  /**
   * The scale of the CKB (Common Knowledge Base) in a numeric format.
   *
   * @type {ccc.NumLike}
   */
  ckbScale: ccc.NumLike;

  /**
   * The scale of the UDT (User Defined Token) in a numeric format.
   *
   * @type {ccc.NumLike}
   */
  udtScale: ccc.NumLike;
}

/**
 * Represents a ratio of two scales, CKB and UDT, with validation and comparison methods.
 *
 * @class Ratio
 * @extends {mol.Entity.Base<RatioLike, Ratio>}
 * @codec {mol.struct({ ckbScale: mol.Uint64, udtScale: mol.Uint64 })}
 */
@mol.codec(
  mol.struct({
    ckbScale: mol.Uint64,
    udtScale: mol.Uint64,
  }),
)
export class Ratio extends mol.Entity.Base<RatioLike, Ratio>() {
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
   * Creates a Ratio instance from a RatioLike object.
   *
   * @static
   * @param {RatioLike} ratio - The ratio-like object to convert.
   * @returns {Ratio} The created Ratio instance.
   */
  static override from(ratio: RatioLike): Ratio {
    if (ratio instanceof Ratio) {
      return ratio;
    }

    const { ckbScale, udtScale } = ratio;
    return new Ratio(ccc.numFrom(ckbScale), ccc.numFrom(udtScale));
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
   * @type {RatioLike}
   */
  ckbToUdt: RatioLike;

  /**
   * The ratio for converting UDT to CKB.
   *
   * @type {RatioLike}
   */
  udtToCkb: RatioLike;

  /**
   * The minimum match log value for CKB.
   *
   * @type {ccc.NumLike}
   */
  ckbMinMatchLog: ccc.NumLike;
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
   * @param {Ratio} ratio - The ratio to use for conversion.
   * @param {number} [ckbMinMatchLog=Info.ckbMinMatchLogDefault()] - The minimum match log value for CKB.
   * @returns {Info} The created Info instance.
   */
  static create(
    isCkb2Udt: boolean,
    ratio: Ratio,
    ckbMinMatchLog = Info.ckbMinMatchLogDefault(),
  ): Info {
    return new Info(
      isCkb2Udt ? ratio : Ratio.empty(),
      isCkb2Udt ? Ratio.empty() : ratio,
      ckbMinMatchLog,
    );
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
        throw Error(
          "Info invalid: ckbToUdt is Empty, but udtToCkb is not Populated",
        );
      }
    }

    if (this.udtToCkb.isEmpty()) {
      if (this.ckbToUdt.isPopulated()) {
        return;
      } else {
        throw Error(
          "Info invalid: udtToCkb is Empty, but ckbToUdt is not Populated",
        );
      }
    }

    if (!this.ckbToUdt.isPopulated() || !this.udtToCkb.isPopulated()) {
      throw Error(
        "Info invalid: both ckbToUdt and udtToCkb should be Populated",
      );
    }

    // Check that if we convert from ckb to udt and then back from udt to ckb, it doesn't lose value.
    if (
      this.ckbToUdt.ckbScale * this.udtToCkb.udtScale <
      this.ckbToUdt.udtScale * this.udtToCkb.ckbScale
    ) {
      throw Error(
        "Info invalid: udtToCkb and ckbToUdt allow order value to be extracted",
      );
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
   * @type {ccc.NumLike}
   */
  udtAmount: ccc.NumLike;

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
 * @codec {mol.struct({ udtAmount: mol.Uint128, master: MasterCodec, info: Info })}
 */
@mol.codec(
  mol.struct({
    udtAmount: mol.Uint128,
    master: MasterCodec,
    info: Info,
  }),
)
export class OrderData extends mol.Entity.Base<OrderDataLike, OrderData>() {
  /**
   * Creates an instance of OrderData.
   *
   * @param {ccc.Num} udtAmount - The amount of UDT.
   * @param {Master} master - The master information.
   * @param {Info} info - The additional information.
   */
  constructor(
    public udtAmount: ccc.Num,
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

    const { udtAmount, master, info } = data;
    return new OrderData(
      ccc.numFrom(udtAmount),
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
    if (this.udtAmount < 0) {
      throw Error("UdtAmount invalid, negative");
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
