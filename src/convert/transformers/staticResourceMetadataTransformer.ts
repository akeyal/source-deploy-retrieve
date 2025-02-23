/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { basename, dirname, isAbsolute, join } from 'path';
import { Readable } from 'stream';
import { create as createArchive } from 'archiver';
import { getExtension } from 'mime';
import { Open } from 'unzipper';
import { JsonMap } from '@salesforce/ts-types';
import { createWriteStream } from 'graceful-fs';
import { Messages, SfError } from '@salesforce/core';
import { baseName } from '../../utils';
import { WriteInfo } from '..';
import { SourceComponent } from '../../resolve';
import { SourcePath } from '../../common';
import { ensureFileExists } from '../../utils/fileSystemHandler';
import { pipeline } from '../streams';
import { BaseMetadataTransformer } from './baseMetadataTransformer';

Messages.importMessagesDirectory(__dirname);
const messages = Messages.load('@salesforce/source-deploy-retrieve', 'sdr', [
  'error_static_resource_expected_archive_type',
  'error_static_resource_missing_resource_file',
]);

export class StaticResourceMetadataTransformer extends BaseMetadataTransformer {
  public static readonly ARCHIVE_MIME_TYPES = new Set([
    'application/zip',
    'application/x-zip-compressed',
    'application/jar',
  ]);

  // allowed to preserve API
  // eslint-disable-next-line class-methods-use-this
  public async toMetadataFormat(component: SourceComponent): Promise<WriteInfo[]> {
    const { content, type, xml } = component;

    let contentSource: Readable;

    if (await componentIsExpandedArchive(component)) {
      // toolbelt was using level 9 for static resources, so we'll do the same.
      // Otherwise, you'll see errors like https://github.com/forcedotcom/cli/issues/1098
      const zip = createArchive('zip', { zlib: { level: 9 } });
      zip.directory(content, false);
      void zip.finalize();
      contentSource = zip;
    } else {
      contentSource = component.tree.stream(content);
    }

    return [
      {
        source: contentSource,
        output: join(type.directoryName, `${baseName(content)}.${type.suffix}`),
      },
      {
        source: component.tree.stream(xml),
        output: join(type.directoryName, basename(xml)),
      },
    ];
  }

  public async toSourceFormat(component: SourceComponent, mergeWith?: SourceComponent): Promise<WriteInfo[]> {
    const { xml, content } = component;

    if (!content) {
      return [];
    }
    const componentContentType = await getContentType(component);
    const mergeContentPath = mergeWith?.content;
    const baseContentPath = getBaseContentPath(component, mergeWith);

    // only unzip an archive component if there isn't a merge component, or the merge component is itself expanded
    const shouldUnzipArchive =
      StaticResourceMetadataTransformer.ARCHIVE_MIME_TYPES.has(componentContentType) &&
      (!mergeWith || mergeWith.tree.isDirectory(mergeContentPath));

    if (shouldUnzipArchive) {
      // for the bulk of static resource writing we'll start writing ASAP
      // we'll still defer writing the resource-meta.xml file by pushing it onto the writeInfos
      await Promise.all(
        (
          await Open.buffer(await component.tree.readFile(content))
        ).files
          .filter((f) => f.type === 'File')
          .map(async (f) => {
            const path = join(baseContentPath, f.path);
            const fullDest = isAbsolute(path)
              ? path
              : join(this.defaultDirectory || component.getPackageRelativePath('', 'source'), path);
            // push onto the pipeline and start writing now
            return this.pipeline(f.stream(), fullDest);
          })
      );
    }
    return [
      {
        source: component.tree.stream(xml),
        output: mergeWith?.xml || component.getPackageRelativePath(basename(xml), 'source'),
      },
    ].concat(
      shouldUnzipArchive
        ? []
        : [
            {
              source: component.tree.stream(content),
              output: `${baseContentPath}.${getExtensionFromType(componentContentType)}`,
            },
          ]
    );
  }

  /**
   * Only separated into its own method for unit testing purposes
   * I was unable to find a way to stub/spy a pipline() call
   *
   * @param stream the data to be written
   * @param destination the destination path to be written
   * @private
   */
  // eslint-disable-next-line class-methods-use-this
  private async pipeline(stream: Readable, destination: string): Promise<void> {
    ensureFileExists(destination);
    await pipeline(stream, createWriteStream(destination));
  }

  /**
   * "Expanded" refers to a component whose content file is a zip file, and its current
   * state is unzipped.
   */
}

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
const FALLBACK_TYPE_MAP = new Map<string, string>([
  ['text/javascript', 'js'],
  ['application/x-javascript', 'js'],
  ['application/x-zip-compressed', 'zip'],
  ['text/x-haml', 'haml'],
  ['image/x-png', 'png'],
  ['text/xml', 'xml'],
]);

const getContentType = async (component: SourceComponent): Promise<string> => {
  const resource = (await component.parseXml()).StaticResource as JsonMap;

  if (!resource || !Object.prototype.hasOwnProperty.call(resource, 'contentType')) {
    throw new SfError(
      messages.getMessage('error_static_resource_missing_resource_file', [join('staticresources', component.name)]),
      'LibraryError'
    );
  }

  return resource.contentType as string;
};

const getBaseContentPath = (component: SourceComponent, mergeWith?: SourceComponent): SourcePath => {
  const baseContentPath = mergeWith?.content || component.getPackageRelativePath(component.content, 'source');
  return join(dirname(baseContentPath), baseName(baseContentPath));
};

const getExtensionFromType = (contentType: string): string =>
  // return registered ext, fallback, or the default (application/octet-stream -> bin)
  getExtension(contentType) ?? FALLBACK_TYPE_MAP.get(contentType) ?? getExtension(DEFAULT_CONTENT_TYPE);

const componentIsExpandedArchive = async (component: SourceComponent): Promise<boolean> => {
  const { content, tree } = component;
  if (tree.isDirectory(content)) {
    const contentType = await getContentType(component);
    if (StaticResourceMetadataTransformer.ARCHIVE_MIME_TYPES.has(contentType)) {
      return true;
    }
    throw new SfError(
      messages.getMessage('error_static_resource_expected_archive_type', [contentType, component.name]),
      'LibraryError'
    );
  }
  return false;
};
