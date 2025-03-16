import { ccc, mol } from "@ckb-ccc/core";
import { getCkbUnoccupied, Int32, union } from "@ickb/dao";

export interface RatioLike {
  ckbScale: ccc.NumLike;
  udtScale: ccc.NumLike;
}

@mol.codec(
  mol.struct({
    ckbScale: mol.Uint64,
    udtScale: mol.Uint64,
  }),
)
export class Ratio extends mol.Entity.Base<RatioLike, Ratio>() {
  constructor(
    public ckbScale: ccc.Num,
    public udtScale: ccc.Num,
  ) {
    super();
  }

  static override from(ratio: RatioLike): Ratio {
    if (ratio instanceof Ratio) {
      return ratio;
    }

    const { ckbScale, udtScale } = ratio;
    return new Ratio(ccc.numFrom(ckbScale), ccc.numFrom(udtScale));
  }

  validate(): void {
    if (!this.isEmpty() && !this.isPopulated()) {
      throw Error("Ration invalid: not empty, not populated");
    }
  }

  isEmpty(): boolean {
    return this.ckbScale === 0n && this.udtScale === 0n;
  }

  isPopulated(): boolean {
    return this.ckbScale > 0n && this.udtScale > 0n;
  }

  static empty(): Ratio {
    return new Ratio(0n, 0n);
  }
}

export interface InfoLike {
  ckbToUdt: RatioLike;
  udtToCkb: RatioLike;
  ckbMinMatchLog: ccc.NumLike;
}

@mol.codec(
  mol.struct({
    ckbToUdt: Ratio,
    udtToCkb: Ratio,
    ckbMinMatchLog: mol.Uint8,
  }),
)
export class Info extends mol.Entity.Base<InfoLike, Info>() {
  constructor(
    public ckbToUdt: Ratio,
    public udtToCkb: Ratio,
    public ckbMinMatchLog: number,
  ) {
    super();
  }

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

  getCkbMinMatch(): ccc.FixedPoint {
    return 1n << BigInt(this.ckbMinMatchLog);
  }

  // It can also be dual ratio
  isCkb2Udt(): boolean {
    return this.ckbToUdt.isPopulated();
  }

  // It can also be dual ratio
  isUdt2Ckb(): boolean {
    return this.udtToCkb.isPopulated();
  }

  isDualRatio(): boolean {
    return this.isCkb2Udt() && this.isUdt2Ckb();
  }

  static ckbMinMatchLogDefault(): number {
    return 33; // ~ 86 CKB
  }
}

export interface RelativeLike {
  padding: ccc.BytesLike;
  distance: ccc.NumLike;
}

@mol.codec(
  mol.struct({
    padding: mol.Byte32,
    distance: Int32,
  }),
)
export class Relative extends mol.Entity.Base<RelativeLike, Relative>() {
  constructor(
    public padding: ccc.Bytes,
    public distance: ccc.Num,
  ) {
    super();
  }

  static override from(relative: RelativeLike): Relative {
    if (relative instanceof Relative) {
      return relative;
    }

    const { padding, distance } = relative;
    return new Relative(ccc.bytesFrom(padding), ccc.numFrom(distance));
  }

  static create(distance: ccc.Num): Relative {
    return new Relative(Relative.padding(), distance);
  }

  static padding(): ccc.Bytes {
    return new Uint8Array(32);
  }

  validate(): void {
    if (this.padding.length != 32 || this.padding.some((x) => x !== 0)) {
      throw Error("Relative master invalid, non standard padding");
    }
  }
}

export const MasterCodec = union({
  relative: Relative,
  absolute: ccc.OutPoint,
});

export type MasterLike = mol.EncodableType<typeof MasterCodec>;
export type Master = mol.DecodedType<typeof MasterCodec>;

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

export interface DataLike {
  udtAmount: ccc.NumLike;
  master: MasterLike;
  info: InfoLike;
}

@mol.codec(
  mol.struct({
    udtAmount: mol.Uint128,
    master: MasterCodec,
    info: Info,
  }),
)
export class Data extends mol.Entity.Base<DataLike, Data>() {
  constructor(
    public udtAmount: ccc.Num,
    public master: Master,
    public info: Info,
  ) {
    super();
  }

  static override from(data: DataLike): Data {
    if (data instanceof Data) {
      return data;
    }

    const { udtAmount, master, info } = data;
    return new Data(
      ccc.numFrom(udtAmount),
      masterFrom(master),
      Info.from(info),
    );
  }

  validate(): void {
    if (this.udtAmount < 0) {
      throw Error("UdtAmount invalid, negative");
    }
    masterValidate(this.master);
    this.info.validate();
  }

  isMint(): boolean {
    return this.master.type === "relative";
  }

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

export class OrderCell {
  constructor(
    public cell: ccc.Cell,
    public data: Data,
    public ckbUnoccupied: ccc.FixedPoint,
    public absTotal: ccc.Num,
    public absProgress: ccc.Num,
  ) {}

  static from(cell: ccc.Cell): OrderCell {
    const data = Data.decode(cell.outputData);
    data.validate();

    const udtAmount = data.udtAmount;
    const ckbUnoccupied = getCkbUnoccupied(cell);

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

    return new OrderCell(cell, data, ckbUnoccupied, absTotal, absProgress);
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
}
