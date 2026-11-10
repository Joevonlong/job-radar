"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { deleteImageAction } from "@/app/career/documents/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DocumentStatus, documentReplySchema } from "./document-shared";

export function DocumentImages({
  initial,
  maxBytes,
  onChange,
}: {
  initial: { photo: boolean; signature: boolean };
  maxBytes: number;
  onChange: () => void;
}) {
  const t = useTranslations("career.documents");
  const [images, setImages] = useState(initial);
  const [code, setCode] = useState("");
  const [pending, startTransition] = useTransition();
  function upload(kind: "photo" | "signature", file: File) {
    if (file.size > maxBytes) {
      setCode("too_large");
      return;
    }
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      setCode("bad_type");
      return;
    }
    startTransition(async () => {
      try {
        const response = await fetch(`/api/career/images?kind=${kind}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: file,
        });
        const result = documentReplySchema.safeParse(await response.json());
        if (!result.success) {
          setCode("request_failed");
          return;
        }
        if (!result.data.ok) {
          setCode(result.data.error);
          return;
        }
        setImages((old) => ({ ...old, [kind]: true }));
        setCode("saved");
        onChange();
      } catch {
        setCode("request_failed");
      }
    });
  }
  function remove(kind: "photo" | "signature") {
    startTransition(async () => {
      try {
        const result = await deleteImageAction({ kind });
        if (!result.ok) {
          setCode(result.code);
          return;
        }
        setImages((old) => ({ ...old, [kind]: false }));
        setCode("saved");
        onChange();
      } catch {
        setCode("request_failed");
      }
    });
  }
  return (
    <fieldset disabled={pending} className="flex min-w-0 flex-col gap-3">
      <legend className="mb-2 text-title">{t("images")}</legend>
      <p className="text-body-sm text-ink-2">{t("imageHint", { bytes: maxBytes })}</p>
      <p className="text-body-sm text-ink-2">{t("sharedImages")}</p>
      {(["photo", "signature"] as const).map((kind) => (
        <div key={kind} className="flex min-w-0 flex-col gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-label">
            {t(`upload.${kind}`)}
            <Input
              type="file"
              accept="image/png,image/jpeg"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) upload(kind, file);
                event.target.value = "";
              }}
            />
          </label>
          <p className="text-body-sm">{t(images[kind] ? "imageExists" : "imageMissing")}</p>
          {images[kind] && (
            <Button variant="outline" onClick={() => remove(kind)}>
              {t(`removeImage.${kind}`)}
            </Button>
          )}
        </div>
      ))}
      <DocumentStatus code={code} />
    </fieldset>
  );
}
