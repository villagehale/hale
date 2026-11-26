import { shoreSrc } from './assets';

/**
 * The pricing hero's shore stack: the same image, crop, drift, and scrim
 * `/pricing` paints inside `.stage.sp-stage`.
 */
export function ShoreArt() {
  return (
    <>
      <img className="shore-art" src={shoreSrc} alt="" aria-hidden="true" />
      <span className="shore-drift sky" aria-hidden="true" />
      <span className="shore-drift sea" aria-hidden="true" />
      <span className="shore-scrim" aria-hidden="true" />
    </>
  );
}
