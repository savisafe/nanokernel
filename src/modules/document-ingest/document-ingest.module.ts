import { Module } from "@nestjs/common";
import { DocumentIngestService } from "./document-ingest.service";

@Module({
  providers: [DocumentIngestService],
  exports: [DocumentIngestService],
})
export class DocumentIngestModule {}
