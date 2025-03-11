import { ccc, mol } from "@ckb-ccc/core";
import { Int32, UdtData } from "@ickb/dao";

export const Ratio = mol.struct({
  ckbMultiplier: mol.Uint64,
  udtMultiplier: mol.Uint64,
});

export const OrderInfo = mol.struct({
  ckbToUdt: Ratio,
  udtToCkb: Ratio,
  ckbMinMatchLog: mol.Uint8,
});

export const MintOrderData = mol.struct({
  padding: mol.Byte32,
  masterDistance: Int32,
  orderInfo: OrderInfo,
});

export const MatchOrderData = mol.struct({
  masterOutpoint: ccc.OutPoint,
  orderInfo: OrderInfo,
});

export const PartialOrderData = mol.union({
  MintOrderData,
  MatchOrderData,
});

export type EncodableOrder = mol.EncodableType<typeof UdtData> &
  mol.EncodableType<typeof PartialOrderData>;
export type DecodedOrder = mol.DecodedType<typeof UdtData> &
  mol.DecodedType<typeof PartialOrderData>;

export const OrderData = mol.Codec.from<DecodedOrder, EncodableOrder>({
  encode: (encodableOrder) => {
    return ccc.bytesConcat(
      UdtData.encode(encodableOrder),
      PartialOrderData.encode(encodableOrder),
    );
  },
  decode: (bufferLike): DecodedOrder => {
    const buffer = ccc.bytesFrom(bufferLike);
    const encodedUdtData = buffer.slice(0, UdtData.byteLength);
    const encodedOrderData = buffer.slice(UdtData.byteLength);

    const udtData = UdtData.decode(encodedUdtData);
    const orderData = PartialOrderData.decode(encodedOrderData);

    return { ...udtData, ...orderData };
  },
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  byteLength: UdtData.byteLength! + MintOrderData.byteLength!,
});
