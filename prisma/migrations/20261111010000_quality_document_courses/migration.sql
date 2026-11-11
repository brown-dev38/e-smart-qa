ALTER TABLE `docs_qa_documents` ADD COLUMN `course_id` INTEGER UNSIGNED NULL;
CREATE INDEX `docs_qa_documents_course_id_idx` ON `docs_qa_documents`(`course_id`);
ALTER TABLE `docs_qa_documents` ADD CONSTRAINT `docs_qa_documents_course_id_fkey`
  FOREIGN KEY (`course_id`) REFERENCES `docs_courses`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
