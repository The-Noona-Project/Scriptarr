"use client";

/** @file Render one logical page from its complete ordered set of image segments. */
import {useEffect, useRef} from "react";
import {readerPageImageKey, resolveReaderPageImages} from "../lib/pageSegments.js";

/**
 * Keep source-page geometry, navigation and readiness intact for tiled WebP.
 * @param {{page:any,onLoad?:Function,onError?:Function,[key:string]:any}} props Image callbacks and attributes.
 * @returns {import("react").ReactNode} One image or a geometrically equivalent composite.
 */
export default function ReaderLogicalImage({page, onLoad, onError, ...attributes}) {
  const images = resolveReaderPageImages(page);
  const identity = readerPageImageKey(page);
  const active = useRef(true);
  const loaded = useRef(new Set());
  const nodes = useRef(new Map());
  const failed = useRef(false);
  const reported = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  if (images.length <= 1) return images.length ? <img {...attributes} src={images[0].src}
    width={Number.isFinite(page.width) && page.width > 0 ? page.width : undefined}
    height={Number.isFinite(page.height) && page.height > 0 ? page.height : undefined}
    onLoad={onLoad} onError={onError} /> : null;
  const fail = (event) => {
    if (!failed.current) {
      failed.current = true;
      onError?.(event);
    }
  };
  const load = (event, index) => {
    const node = event.currentTarget;
    nodes.current.set(index, node);
    loaded.current.add(index);
    if (loaded.current.size !== images.length || failed.current || reported.current) return;
    reported.current = true;
    void Promise.all([...nodes.current.values()].map((image) => Promise.resolve().then(() => typeof image.decode === "function" ? image.decode() : undefined)))
      .then(() => {
        if (active.current && !failed.current) onLoad?.({currentTarget: node});
      }, () => {
        if (active.current) fail({currentTarget: node});
      });
  };
  return <div className="reader-logical-image" role="img" aria-label={attributes.alt}
    style={{"--reader-page-ratio": page.width / page.height, "--reader-page-width": `${page.width}px`, aspectRatio: `${page.width} / ${page.height}`}}>
    {images.map((image) => <img {...attributes} key={`${identity}:${image.index}`} alt="" aria-hidden="true"
      className="reader-page-segment" src={image.src}
      style={{left: `${image.x / page.width * 100}%`, top: `${image.y / page.height * 100}%`,
        width: `${image.width / page.width * 100}%`, height: `${image.height / page.height * 100}%`}}
      onLoad={(event) => load(event, image.index)} onError={fail} />)}
  </div>;
}
