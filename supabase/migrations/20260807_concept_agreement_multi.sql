-- Понятийное соглашение договора теперь может содержать НЕСКОЛЬКО документов
-- (согласований может быть несколько). Файлы хранятся как s3_documents с
-- owner_type='contract' и doc_category='concept_agreement'.
--
-- Ранее было по одному файлу через contracts.concept_agreement_s3_document_id
-- (у этих файлов doc_category='general'). Помечаем их категорией 'concept_agreement',
-- чтобы они попали в новый список понятийных соглашений. Колонку
-- concept_agreement_s3_document_id оставляем (не используется, для отката/совместимости).

UPDATE s3_documents s
SET doc_category = 'concept_agreement'
FROM contracts c
WHERE c.concept_agreement_s3_document_id = s.id
  AND s.owner_type = 'contract'
  AND s.doc_category IS DISTINCT FROM 'concept_agreement';
